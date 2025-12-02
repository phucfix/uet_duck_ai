// Chờ cho toàn bộ trang web được tải xong
document.addEventListener('DOMContentLoaded', () => {
  const chatForm  = document.getElementById('chat-form');
  const userInput = document.getElementById('user-input');
  const chatBox   = document.getElementById('chat-box');

  // Vì index.html đang được serve từ http://localhost:4000
  // nên ta dùng đường dẫn tương đối:
  const backendUrl = '/chat';

  chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const userMessage = userInput.value.trim();
    if (!userMessage) return;

    // Hiển thị tin nhắn của người dùng
    addMessage(userMessage, 'user');
    userInput.value = '';

    try {
      const response = await fetch(backendUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        // 🚩 KEY PHẢI LÀ "prompt" ĐÚNG VỚI server.js
        body: JSON.stringify({ prompt: userMessage }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('Response not OK:', response.status, errText);
        addMessage('Xin lỗi, server đang lỗi: ' + response.status, 'ai');
        return;
      }

      let data;
      try {
        data = await response.json();
      } catch (err) {
        console.error('Không parse được JSON:', err);
        addMessage('Xin lỗi, mình không đọc được phản hồi từ server.', 'ai');
        return;
      }

      console.log('API data:', data);

      // Lấy nội dung trả lời từ field "response"
      const botText =
        (typeof data.response === 'string' && data.response.trim().length > 0)
          ? data.response
          : '[Không nhận được nội dung trả lời từ server]';

      addMessage(botText, 'ai');

    } catch (error) {
      console.error('Lỗi khi gọi API:', error);
      addMessage('Xin lỗi, mình gặp chút trục trặc. Bạn thử lại sau nhé!', 'ai');
    }
  });

  // Hàm thêm tin nhắn vào khung chat
  function addMessage(text, sender) {
    const messageElement = document.createElement('div');
    messageElement.classList.add('message', sender);
    messageElement.innerHTML = `<p>${text}</p>`;
    chatBox.appendChild(messageElement);
    chatBox.scrollTop = chatBox.scrollHeight;
  }
});
