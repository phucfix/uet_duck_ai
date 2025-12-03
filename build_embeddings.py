import os
import json
import hashlib
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
import google.generativeai as genai
from pypdf import PdfReader


# ---------- Cấu hình ----------
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"           # thư mục chứa PDF/TXT
OUT_PATH = BASE_DIR / "embeddings.json"

CHUNK_SIZE = 800
CHUNK_OVERLAP = 200


# ---------- Setup Gemini ----------
load_dotenv()
api_key = os.getenv("GEMINI_API_KEY")
if not api_key:
    raise RuntimeError("GEMINI_API_KEY not found in environment/.env")

genai.configure(api_key=api_key)


# ---------- Hàm tiện ích ----------

def extract_text_from_pdf(path: Path) -> str:
    """Đọc toàn bộ text từ file PDF."""
    reader = PdfReader(str(path))
    texts = []
    for page in reader.pages:
        txt = page.extract_text()
        if txt:
            texts.append(txt)
    return "\n".join(texts)


def extract_text_from_txt(path: Path) -> str:
    """Đọc text từ .txt / .md."""
    return path.read_text(encoding="utf-8")


def split_into_chunks(
    text: str,
    chunk_size: int = CHUNK_SIZE,
    overlap: int = CHUNK_OVERLAP,
) -> list[str]:
    """Chia text thành các đoạn nhỏ có overlap (theo ký tự)."""
    chunks: list[str] = []
    start = 0
    length = len(text)

    while start < length:
        end = min(start + chunk_size, length)
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        start += (chunk_size - overlap)

    return chunks


def compute_chunk_hash(chunk: str) -> str:
    """Tính hash ổn định cho 1 đoạn text."""
    return hashlib.sha256(chunk.encode("utf-8")).hexdigest()


def embed_text(text: str) -> list[float]:
    """Gọi Gemini để lấy embedding cho 1 đoạn text."""
    result = genai.embed_content(
        model="models/text-embedding-004",
        content=text,
    )

    # Tùy phiên bản SDK, 'embedding' có thể là list hoặc object
    embedding: Any = None
    if isinstance(result, dict):
        embedding = result.get("embedding")
    else:
        # Một số SDK có thể trả về object có thuộc tính 'embedding'
        embedding = getattr(result, "embedding", None)

    if isinstance(embedding, dict) and "values" in embedding:
        embedding = embedding["values"]

    if not isinstance(embedding, list):
        raise RuntimeError(f"Unexpected embedding format: {type(embedding)}")

    return embedding  # type: ignore[return-value]


def load_existing_embeddings() -> list[dict]:
    """Đọc embeddings.json nếu tồn tại, ngược lại trả về list rỗng."""
    if not OUT_PATH.exists():
        return []

    try:
        data = json.loads(OUT_PATH.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return data
        else:
            print("Warning: embeddings.json không phải dạng list, bỏ qua.")
            return []
    except Exception as e:
        print(f"Warning: không đọc được {OUT_PATH.name}: {e}")
        return []


# ---------- Main build embeddings (incremental) ----------

def main():
    if not DATA_DIR.exists():
        raise RuntimeError(f"Data folder not found: {DATA_DIR}")

    # 1) Load embeddings cũ (nếu có)
    print(f"Loading existing embeddings from {OUT_PATH.name} (nếu có)...")
    existing_embeddings = load_existing_embeddings()

    # 2) Build index: (source, hash) -> item
    existing_index: dict[tuple[str, str], dict] = {}

    for item in existing_embeddings:
        source = str(item.get("source", ""))
        chunk = item.get("chunk")

        if not source or not isinstance(chunk, str):
            continue

        # Nếu chưa có hash, tính lại từ chunk (hỗ trợ file cũ)
        h = item.get("hash")
        if not isinstance(h, str):
            h = compute_chunk_hash(chunk)
            item["hash"] = h  # enrich để lần sau dùng nhanh hơn

        key = (source, h)
        existing_index[key] = item

    print(f"Existing embeddings loaded: {len(existing_embeddings)} records.")
    print(f"Indexed pairs (source, hash): {len(existing_index)}\n")

    # 3) Xử lý lại toàn bộ file hiện có (nhưng tái sử dụng embedding khi có thể)
    files = sorted(DATA_DIR.iterdir())
    new_embeddings: list[dict] = []

    reused_count = 0
    new_count = 0

    for f in files:
        if not f.is_file():
            continue

        ext = f.suffix.lower()
        print(f"Processing {f.name} ...")

        if ext == ".pdf":
            text = extract_text_from_pdf(f)
        elif ext in (".txt", ".md"):
            text = extract_text_from_txt(f)
        else:
            print(f"  -> skip (unsupported extension: {ext})")
            continue

        if not text.strip():
            print("  -> no text extracted, skip")
            continue

        chunks = split_into_chunks(text)
        file_mtime = f.stat().st_mtime

        for i, chunk in enumerate(chunks):
            h = compute_chunk_hash(chunk)
            key = (f.name, h)

            # Mặc định: cần embed mới
            embedding = None
            reused = False

            if key in existing_index:
                # Reuse embedding cũ
                embedding = existing_index[key].get("embedding")
                reused = True

            if embedding is None:
                # Không có hoặc embedding bị null -> gọi Gemini
                embedding = embed_text(chunk)
                new_count += 1
                status = "NEW"
            else:
                reused_count += 1
                status = "REUSED"

            emb_record = {
                "id": f"{f.name}__chunk_{i}",
                "source": f.name,
                "chunk": chunk,
                "embedding": embedding,
                "hash": h,
                "file_mtime": file_mtime,
            }
            new_embeddings.append(emb_record)

            preview = chunk[:60].replace("\n", " ")
            print(f"  -> chunk {i:04d} [{status}] ({preview}...)")

    # 4) Ghi file embeddings.json mới (chỉ dựa trên file hiện có)
    OUT_PATH.write_text(
        json.dumps(new_embeddings, ensure_ascii=False),
        encoding="utf-8",
    )

    print("\nDone.")
    print(f"  Total chunks:       {len(new_embeddings)}")
    print(f"  Reused embeddings:  {reused_count}")
    print(f"  New embeddings:     {new_count}")
    print(f"Saved to {OUT_PATH.name}")


if __name__ == "__main__":
    main()
