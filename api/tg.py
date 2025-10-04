from __future__ import annotations
import httpx
from typing import Any, Dict, Optional


class Telegram:
    def __init__(self, token: str, timeout: float = 15.0) -> None:
        self.base = f"https://api.telegram.org/bot{token}"
        self.timeout = timeout
        self._client = httpx.AsyncClient(timeout=timeout)

    async def close(self):
        await self._client.aclose()

    async def api(self, method: str, data: Dict[str, Any] | None = None, files: Dict[str, Any] | None = None):
        url = f"{self.base}/{method}"
        r = await self._client.post(url, data=data, files=files)
        r.raise_for_status()
        j = r.json()
        if not j.get('ok'):
            raise RuntimeError(j)
        return j['result']

    async def send_text(self, chat_id: str | int, text: str, reply_markup: Optional[dict] = None, disable_link_preview: bool = True):
        data = {
            'chat_id': chat_id,
            'text': text,
            'parse_mode': 'HTML',
            'disable_web_page_preview': disable_link_preview,
        }
        # httpx won't JSON encode nested form data; we pass json encoded string
        if reply_markup:
            import json
            data['reply_markup'] = json.dumps(reply_markup)
        return await self.api('sendMessage', data=data)

    async def send_document(self, chat_id: str | int, caption: Optional[str], document, filename: Optional[str] = None, reply_markup: Optional[dict] = None):
        data: Dict[str, Any] = {'chat_id': chat_id}
        if caption:
            data['caption'] = caption
            data['parse_mode'] = 'HTML'
        files = None
        if isinstance(document, (str, int)):
            data['document'] = document
        else:
            key = 'document'
            files = {key: (filename or 'file', document)}
        if reply_markup:
            import json
            data['reply_markup'] = json.dumps(reply_markup)
        return await self.api('sendDocument', data=data, files=files)

    async def send_photo(self, chat_id: str | int, caption: Optional[str], photo, reply_markup: Optional[dict] = None):
        data: Dict[str, Any] = {'chat_id': chat_id}
        if caption:
            data['caption'] = caption
            data['parse_mode'] = 'HTML'
        files = None
        if isinstance(photo, (str, int)):
            data['photo'] = photo
        else:
            files = {'photo': ('image', photo)}
        if reply_markup:
            import json
            data['reply_markup'] = json.dumps(reply_markup)
        return await self.api('sendPhoto', data=data, files=files)

    async def send_audio(self, chat_id: str | int, caption: Optional[str], audio, title: Optional[str] = None, performer: Optional[str] = None, reply_markup: Optional[dict] = None):
        data: Dict[str, Any] = {'chat_id': chat_id}
        if caption:
            data['caption'] = caption
            data['parse_mode'] = 'HTML'
        if title:
            data['title'] = title
        if performer:
            data['performer'] = performer
        files = None
        if isinstance(audio, (str, int)):
            data['audio'] = audio
        else:
            files = {'audio': ('audio', audio)}
        if reply_markup:
            import json
            data['reply_markup'] = json.dumps(reply_markup)
        return await self.api('sendAudio', data=data, files=files)

    async def send_video(self, chat_id: str | int, caption: Optional[str], video, reply_markup: Optional[dict] = None):
        data: Dict[str, Any] = {'chat_id': chat_id}
        if caption:
            data['caption'] = caption
            data['parse_mode'] = 'HTML'
        files = None
        if isinstance(video, (str, int)):
            data['video'] = video
        else:
            files = {'video': ('video', video)}
        if reply_markup:
            import json
            data['reply_markup'] = json.dumps(reply_markup)
        return await self.api('sendVideo', data=data, files=files)

    async def edit_caption(self, chat_id: str | int, message_id: int, caption: str):
        return await self.api('editMessageCaption', data={
            'chat_id': chat_id,
            'message_id': message_id,
            'caption': caption,
            'parse_mode': 'HTML'
        })

    async def edit_text(self, chat_id: str | int, message_id: int, text: str):
        return await self.api('editMessageText', data={
            'chat_id': chat_id,
            'message_id': message_id,
            'text': text,
            'parse_mode': 'HTML',
            'disable_web_page_preview': True
        })

    async def answer_callback(self, callback_query_id: str, text: Optional[str] = None, show_alert: bool = False):
        data: Dict[str, Any] = {'callback_query_id': callback_query_id}
        if text:
            data['text'] = text
        if show_alert:
            data['show_alert'] = True
        return await self.api('answerCallbackQuery', data=data)
