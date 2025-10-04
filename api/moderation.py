from __future__ import annotations
import re
from typing import Optional

URL_RE = re.compile(r"https?://|t\.me/|@\w+|\bwww\.", re.IGNORECASE)

BAD_WORDS = [
    # keep list short; add more as needed
    'суицид', 'бомба', 'террор', 'насилие', 'экстремизм'
]

ALLOWED_MIME_PREFIX = (
    'image/', 'audio/', 'video/', 'text/', 'application/pdf',
    'application/zip', 'application/x-zip-compressed', 'application/x-rar-compressed',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/json'
)

BLOCKED_MIME_PREFIX = (
    'application/x-msdownload', 'application/x-sh', 'application/x-executable', 'application/java-archive',
)

def basic_text_moderation(text: str) -> Optional[str]:
    if not text:
        return None
    if URL_RE.search(text) and text.count('http') + text.count('www') > 2:
        return 'Слишком много ссылок в сообщении'
    for w in BAD_WORDS:
        if w in text.lower():
            return 'Сообщение содержит запрещённые слова'
    if len(text) > 4000:
        return 'Слишком длинный текст (>4000)'
    return None

def file_allowed(mime: str, size: int, max_size_bytes: int) -> Optional[str]:
    if not mime:
        return 'Не удалось распознать тип файла'
    if size <= 0:
        return 'Пустой файл'
    if size > max_size_bytes:
        return f'Файл слишком большой (макс {max_size_bytes // (1024*1024)}MB)'
    if mime.startswith(BLOCKED_MIME_PREFIX):
        return 'Этот тип файлов запрещён'
    if mime.startswith(ALLOWED_MIME_PREFIX):
        return None
    # default: treat as document via sendDocument
    return None

