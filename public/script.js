// Chờ cho toàn bộ trang web được tải xong
document.addEventListener('DOMContentLoaded', () => {
  const chatForm  = document.getElementById('chat-form');
  const userInput = document.getElementById('user-input');
  const chatBox   = document.getElementById('chat-box');
  const backendUrl = '/chat';

  // Helpers
  function escapeHtml(unsafe) {
    return unsafe
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatMessageContent(raw) {
    if (!raw) return '';
    // Escape first
    let s = escapeHtml(raw);
    // Triple-backtick blocks -> <pre><code>
    s = s.replace(/```([\s\S]*?)```/g, (m, code) => {
      return `<pre><code>${code}</code></pre>`;
    });
    // Inline `code`
    s = s.replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`);
    // Newlines -> <br>
    s = s.replace(/\n/g, '<br>');
    return s;
  }

  function timeNow() {
    const d = new Date();
    return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  }

  // Typing placeholder
  let typingEl = null;
  function showTyping() {
    typingEl = document.createElement('div');
    typingEl.className = 'message ai typing';
    typingEl.innerHTML = `<div class="meta"><div class="avatar">🦆</div><div class="info"><span class="sender-label">UET Duck</span><time class="time">${timeNow()}</time></div></div><div class="content"><div class="typing"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div></div>`;
    chatBox.appendChild(typingEl);
    chatBox.scrollTop = chatBox.scrollHeight;
  }
  function hideTyping() {
    if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
    typingEl = null;
  }

  // Fetch current user info and update UI
  async function fetchMe() {
    try {
      const resp = await fetch('/api/me', { credentials: 'include' });
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data.user) {
        const linkEl = document.getElementById('auth-link');
        linkEl.textContent = 'Sign in with GitHub';
        linkEl.href = '/auth/github';
        const heartsEl = document.getElementById('hearts');
        if (heartsEl) { heartsEl.textContent = ''; heartsEl.classList.remove('pulse'); }
        return;
      }
      const linkEl = document.getElementById('auth-link');
      linkEl.textContent = `Logout (${data.user.username})`;
      linkEl.href = '/auth/logout';
      const heartsEl = document.getElementById('hearts');
      const newHearts = '♥'.repeat(Math.max(0, data.user.duckLimit));
      if (heartsEl) {
        heartsEl.textContent = newHearts;
        heartsEl.classList.add('pulse');
        setTimeout(() => heartsEl.classList.remove('pulse'), 500);
      }
    } catch (err) {
      console.warn('Could not fetch /api/me', err);
    }
  }

  fetchMe();

  chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const userMessage = userInput.value.trim();
    if (!userMessage) return;

    addMessage(userMessage, 'user');
    userInput.value = '';

    showTyping();

    try {
      const response = await fetch(backendUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: userMessage }),
      });

      if (!response.ok) {
        hideTyping();
        let msg = 'Server error';
        try { msg = await response.text(); } catch(e) {}
        console.error('Response not OK:', response.status, msg);
        if (response.status === 401) {
          addMessage('Bạn cần đăng nhập để dùng AI Duck. Redirecting...', 'ai');
          setTimeout(() => { window.location.href = '/auth/github'; }, 800);
          return;
        }
        if (response.status === 403) {
          addMessage('Bạn đã hết lượt hỏi. Vui lòng nạp thêm hearts.', 'ai');
          fetchMe();
          return;
        }
        addMessage('Xin lỗi, server đang lỗi: ' + response.status, 'ai');
        return;
      }

      let data;
      try { data = await response.json(); } catch (err) { console.error('Không parse JSON:', err); hideTyping(); addMessage('Không nhận được phản hồi hợp lệ.', 'ai'); return; }

      hideTyping();

      const botText = (typeof data.response === 'string' && data.response.trim().length > 0) ? data.response : '[Không nhận được nội dung trả lời từ server]';
      addMessage(botText, 'ai');
      fetchMe();

    } catch (error) {
      hideTyping();
      console.error('Lỗi khi gọi API:', error);
      addMessage('Xin lỗi, mình gặp chút trục trặc. Bạn thử lại sau nhé!', 'ai');
    }
  });

  // Hàm thêm tin nhắn vào khung chat
  function addMessage(text, sender) {
    const messageElement = document.createElement('div');
    messageElement.classList.add('message', sender);

    const avatar = sender === 'user' ? '🙂' : '🦆';
    const time = timeNow();

    const inner = `
      <div class="meta">
        <div class="avatar">${avatar}</div>
        <div class="info"><span class="sender-label">${sender === 'user' ? 'You' : 'UET Duck'}</span><time class="time">${time}</time></div>
      </div>
      <div class="content"><p>${formatMessageContent(text)}</p></div>
    `;

    messageElement.innerHTML = inner;
    chatBox.appendChild(messageElement);
    chatBox.scrollTop = chatBox.scrollHeight;
  }
});
