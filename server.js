const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const dotenv = require('dotenv');
const cors = require('cors');
const path = require('path');
const fs = require('fs'); // ✅ thêm

dotenv.config();

const app = express();
const port = 4000;

// Session & Auth
const session = require('express-session');
const passport = require('passport');
const GitHubStrategy = require('passport-github').Strategy;
const prisma = require('./prisma');

app.use(cors());
app.use(express.json());

app.use(session({
    secret: process.env.SESSION_SECRET || 'changeme',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 } // 1 day
}));

app.use(passport.initialize());
app.use(passport.session());

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));
// -----------------------------------------------------------------------

const systemInstruction = `You are the UET Duck, a friendly and patient Rubber Duck Debugger.
Your language is English.
Your role is to help students solve programming problems *by asking them questions*.
**CRITICAL RULE: Do NOT, under any circumstances, provide direct answers, write code, fix the user's code, or give hints that are too obvious.**
Your ONLY tools are Socratic questions. Guide them to find the "aha!" moment themselves.
- Ask them to explain what their code is *supposed* to do.
- Ask them to explain what it *actually* does.
- Ask them what they have already tried.
Always be encouraging and patient. Your goal is to help them *think*.`;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const modelName = "gemini-flash-latest";

const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: systemInstruction,
});

// ===================== RAG: LOAD EMBEDDINGS =====================

// Load embeddings.json vào RAM
let DOC_EMBEDDINGS = [];

try {
    const raw = fs.readFileSync(path.join(__dirname, 'embeddings.json'), 'utf8');
    DOC_EMBEDDINGS = JSON.parse(raw);
    console.log(`Loaded ${DOC_EMBEDDINGS.length} document chunks from embeddings.json`);
} catch (err) {
    console.warn("Could not load embeddings.json. RAG will be disabled.", err.message);
    DOC_EMBEDDINGS = [];
}

// Hàm cosine similarity
function cosineSimilarity(a, b) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    const len = Math.min(a.length, b.length); // phòng trường hợp lệch dimension

    for (let i = 0; i < len; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Model embedding của Gemini
const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });

// ---------------------- PASSPORT GITHUB ----------------------
passport.serializeUser((user, done) => {
    done(null, user.githubId);
});

passport.deserializeUser(async (githubId, done) => {
    try {
        const user = await prisma.user.findUnique({ where: { githubId } });
        done(null, user || null);
    } catch (err) {
        done(err);
    }
});

passport.use(new GitHubStrategy({
    clientID: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackURL: process.env.GITHUB_CALLBACK_URL || 'http://localhost:4000/auth/github/callback'
}, async (accessToken, refreshToken, profile, done) => {
    try {
        // profile.id is GitHub id
        const githubId = String(profile.id);
        const username = profile.username || profile.displayName || 'github_user';
        const email = (profile.emails && profile.emails[0] && profile.emails[0].value) || null;
        const avatarUrl = (profile.photos && profile.photos[0] && profile.photos[0].value) || null;

        // Tìm user trong DB course-platform, nếu chưa có thì tạo
        let user = await prisma.user.findUnique({ where: { githubId } });
        if (!user) {
            user = await prisma.user.create({
                data: {
                    githubId,
                    username,
                    email,
                    avatarUrl,
                    // duckLimit mặc định theo schema
                }
            });
        } else {
            // Cập nhật thông tin hiển thị
            await prisma.user.update({ where: { githubId }, data: { username, email, avatarUrl } });
        }

        return done(null, user);
    } catch (err) {
        return done(err);
    }
}));

// Auth routes
app.get('/auth/github', passport.authenticate('github'));

app.get('/auth/github/callback', passport.authenticate('github', { failureRedirect: '/' }), (req, res) => {
    // Redirect back to frontend
    res.redirect('/');
});

app.get('/auth/logout', (req, res) => {
    req.logout(() => {});
    req.session.destroy(() => {
        res.redirect('/');
    });
});

// Return current user
app.get('/api/me', async (req, res) => {
    if (!req.user) return res.json({ user: null });
    // Fetch latest from DB
    const user = await prisma.user.findUnique({ where: { githubId: req.user.githubId } });
    if (!user) return res.json({ user: null });
    res.json({ user: { id: user.id, username: user.username, avatarUrl: user.avatarUrl, duckLimit: user.duckLimit } });
});

async function embedQuery(text) {
    // trim nhẹ cho chắc
    text = text.trim();
    const result = await embeddingModel.embedContent({
        content: { parts: [{ text }] },
    });
    // SDK Node của Gemini trả về kiểu { embedding: { values: [...] } }
    const emb = result.embedding;
    return emb.values || emb;
}

async function retrieveContextForQuestion(question) {
    if (!DOC_EMBEDDINGS.length) {
        return { context: null, score: 0, source: null };
    }

    const queryEmbedding = await embedQuery(question);

    let best = null;
    let bestScore = -1;

    for (const doc of DOC_EMBEDDINGS) {
        const score = cosineSimilarity(queryEmbedding, doc.embedding);
        if (score > bestScore) {
            bestScore = score;
            best = doc;
        }
    }

    // ✅ KHÔNG dùng threshold nữa, luôn trả về best_chunk
    if (!best) {
        return { context: null, score: bestScore, source: null };
    }

    return {
        context: best.chunk,
        score: bestScore,
        source: best.source,
    };
}


// ===================== API /chat =====================

app.post('/chat', async (req, res) => {
    try {
        const userPrompt = req.body.prompt;
        if (!userPrompt) {
            return res.status(400).json({ error: "Prompt is required." });
        }

        // Authentication required
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required.' });
        }

        // Lấy user từ DB
        const dbUser = await prisma.user.findUnique({ where: { githubId: req.user.githubId } });
        if (!dbUser) return res.status(401).json({ error: 'User not found.' });

        if (typeof dbUser.duckLimit !== 'number' || dbUser.duckLimit <= 0) {
            return res.status(403).json({ error: 'No remaining questions. Please recharge your hearts.' });
        }

        // Trừ 1 lượt (atomic)
        await prisma.user.update({ where: { id: dbUser.id }, data: { duckLimit: { decrement: 1 } } });

        // 1) Lấy best_chunk từ embeddings (luôn luôn)
        const ragResult = await retrieveContextForQuestion(userPrompt);
        console.log("[RAG] best score =", ragResult.score, "source =", ragResult.source);

        let userMessage;

        if (ragResult.context) {
            userMessage = `
        You are an AI teaching assistant for an e-learning platform.
        The user is asking questions about programming and course content.

        Below is an OPTIONAL excerpt from the official course materials
        (slides, lecture notes, or textbooks):

        --- BEGIN COURSE EXCERPT ---
        ${ragResult.context}
        --- END COURSE EXCERPT ---

        The student's question is:
        "${userPrompt}"

        Follow these rules carefully:

        1. First, decide if the excerpt is clearly relevant to the student's question.
        - If it IS relevant:
            - Treat it as the *primary and authoritative* source.
            - Answer in a way that is consistent with this course.
            - Use phrases like "According to this course" or "In these lecture notes".
            - Do NOT contradict the course materials.
            - Do NOT invent extra facts that are not implied by the excerpt.
        - If it is NOT clearly relevant:
            - Politely ignore the excerpt.
            - Answer using your general programming and computer science knowledge.
            - Make it clear that you are answering based on general knowledge, not the course.

        2. Your style:
        - Be friendly and patient.
        - Explain concepts step by step.
        - When appropriate, ask short Socratic questions to guide the student to think.
        - But if the student clearly wants an explanation, do provide a clear, direct explanation.

        3. If the question is about code or debugging:
        - Behave like the UET Duck:
            - Ask what the code is supposed to do.
            - Ask what it actually does.
            - Ask what they have already tried.
            - Avoid giving full solutions immediately; guide them instead.

        Always answer in English.
        `;
        } else {
            // Không có excerpt (ví dụ chưa có embeddings) -> trả lời như TA bình thường
            userMessage = `
        You are an AI teaching assistant for an e-learning platform.
        The student asked: "${userPrompt}"

        There is no course excerpt available for this question.
        Answer using your general programming knowledge.
        Be friendly, explain clearly, and ask short guiding questions if helpful.
        Always answer in English.
        `;
        }


        const chat = model.startChat({
            history: [
                { role: "user", parts: [{ text: "Hello." }] },
                {
                    role: "model",
                    parts: [{
                        text: "Quack! I'm the UET Duck. I'm here to help you debug. Tell me, what problem are you working on? What is your code supposed to do?"
                    }]
                },
            ],
        });

        const result = await chat.sendMessage(userMessage);
        const response = await result.response;
        const text = response.text();

        res.json({ response: text });

    } catch (error) {
        console.error("Error calling Gemini API:", error);
        res.status(500).json({ error: 'An error occurred on the server.' });
    }
});


// ===================== START SERVER =====================

app.listen(port, () => {
    console.log(`====================================================`);
    console.log(`  UET Duck AI Server đang chạy!`);
    console.log(`  Truy cập ứng dụng tại: http://localhost:${port}`);
    console.log(`====================================================`);
});

// ---------------------- HEARTS RECHARGE JOB ----------------------
const RECHARGE_INTERVAL_MINUTES = parseInt(process.env.RECHARGE_INTERVAL_MINUTES || '60', 10); // default 60 minutes
const RECHARGE_AMOUNT = parseInt(process.env.RECHARGE_AMOUNT || '1', 10); // hearts added each interval
const MAX_DUCK_LIMIT = parseInt(process.env.MAX_DUCK_LIMIT || '5', 10); // maximum hearts per user

async function rechargeHearts() {
    try {
        const users = await prisma.user.findMany({ where: { duckLimit: { lt: MAX_DUCK_LIMIT } } });
        if (!users.length) return;

        for (const u of users) {
            const newVal = Math.min((u.duckLimit || 0) + RECHARGE_AMOUNT, MAX_DUCK_LIMIT);
            if (newVal !== u.duckLimit) {
                await prisma.user.update({ where: { id: u.id }, data: { duckLimit: newVal } });
            }
        }

        console.log(`[recharge] Recharged hearts for ${users.length} users (max ${MAX_DUCK_LIMIT}, +${RECHARGE_AMOUNT}).`);
    } catch (err) {
        console.error('[recharge] Error while recharging hearts:', err);
    }
}

// Start the interval (run immediately, then every interval)
rechargeHearts();
setInterval(rechargeHearts, Math.max(1, RECHARGE_INTERVAL_MINUTES) * 60 * 1000);
