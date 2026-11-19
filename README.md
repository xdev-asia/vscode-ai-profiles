# xDev AI

Extension VS Code để mở terminal Claude Code theo từng tài khoản và trò chuyện trong editor với nhiều hồ sơ API.

## Cài đặt

Cần VS Code hoặc code-server có phiên bản VS Code **1.95 trở lên**.

- **VS Code Desktop** — mở Command Palette, chạy **Extensions: Install from VSIX…** và chọn `xdev-ai-0.2.0.vsix`.
- **VS Code Remote** — mở workspace qua Remote SSH, WSL, Dev Container hoặc Remote Tunnel rồi chạy **Extensions: Install from VSIX…** trong cửa sổ remote. Kiểm tra xDev AI xuất hiện trong nhóm extension của máy remote.
- **code-server** — chép gói lên server và chạy `code-server --install-extension xdev-ai-0.2.0.vsix`, sau đó tải lại cửa sổ trình duyệt.

Extension chạy trên máy chứa workspace. Với workspace remote, máy remote cần kết nối được tới API của nhà cung cấp. Địa chỉ `localhost` của endpoint tùy chỉnh được phân giải trên máy đó. [VS Code Remote](https://code.visualstudio.com/api/advanced-topics/remote-extensions) · [code-server](https://coder.com/docs/code-server/FAQ#how-do-i-install-an-extension-manually)

## Nhiều tài khoản Claude Code

1. Cài Claude Code trên máy chứa workspace. Trên Windows, dùng bản cài native có `claude.exe`. Nếu extension không tìm thấy CLI, đặt đường dẫn tuyệt đối trong `xdevAi.claudeExecutable` ở User Settings hoặc Remote Settings. [Cài Claude Code](https://code.claude.com/docs/en/setup)
2. Chạy **xDev AI: Add Claude Account**, đặt tên hồ sơ và hoàn tất đăng nhập claude.ai trong trình duyệt. Lặp lại với tài khoản thứ hai. Nếu đang dùng máy chủ không có trình duyệt, mở URL mà Claude Code in trong terminal và làm theo hướng dẫn của CLI.
3. Chạy **xDev AI: Open Claude Terminal** rồi chọn tài khoản. Bạn cũng có thể chọn **xDev AI: Claude Code** trong menu cạnh dấu **+** ở Terminal hoặc bấm **Claude Code** trong tab xDev AI. Có thể mở nhiều terminal cùng lúc. Dùng `/status` trong Claude Code để kiểm tra tài khoản hiện tại.
4. Dùng **xDev AI: Sign In to Claude Account** khi cần đăng nhập lại một hồ sơ.

Mỗi hồ sơ đặt `CLAUDE_CONFIG_DIR` riêng trên máy chứa workspace. Claude Code xử lý đăng nhập, lưu phiên và quản lý thông tin xác thực trong môi trường đó. Tài khoản tạo trên Desktop và trên server có phiên đăng nhập riêng. Luồng này dùng tài khoản claude.ai. [Đăng nhập nhiều tài khoản theo hướng dẫn của Anthropic](https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts)

## Chat với API

1. Mở **xDev AI: Open Chat** từ Command Palette.
2. Bấm **Thêm hồ sơ** và chọn nhà cung cấp. Đặt tên dễ phân biệt, nhập model ID và API key. Endpoint tương thích OpenAI cần thêm base URL, ví dụ `http://127.0.0.1:11434/v1` cho Ollama. Có thể bỏ trống khóa nếu endpoint cho phép truy cập không cần xác thực.
3. Bấm **Gửi** hoặc dùng `Ctrl+Enter` / `Cmd+Enter`. Chọn hồ sơ khác trong danh sách khi muốn đổi tài khoản. Mỗi hồ sơ giữ tối đa 12 lượt hỏi đáp gần nhất khi tab chat còn mở.
4. Dùng **Quản lý** để đổi tên, model, API key hoặc xóa hồ sơ. **Đoạn chat mới** xóa lịch sử của hồ sơ đang chọn.

Tab chat xác thực qua API key. Lấy API key và model ID từ [OpenAI](https://developers.openai.com/api/docs/quickstart), [Anthropic](https://platform.claude.com/docs/en/api/messages/create) hoặc [Google AI Studio](https://aistudio.google.com/docs/openai).

Hồ sơ được lưu qua SecretStorage của VS Code. Cấu hình hồ sơ có phạm vi lưu trữ theo môi trường VS Code, vì vậy bạn có thể cần thêm hồ sơ riêng trên server. Cửa sổ chat chỉ gửi nội dung bạn nhập cùng lịch sử của hồ sơ đang chọn. Khi dùng endpoint tùy chỉnh, base URL phải là HTTPS hoặc HTTP qua loopback.

## Dùng như thư viện TypeScript

Phần gọi model có thể dùng độc lập trong Node.js 20.3 trở lên. Từ mã nguồn, chạy `npm ci` rồi `npm pack` để tạo `xdev-ai-0.2.0.tgz`. Cài gói đó vào dự án Node.js của bạn rồi gọi hàm `chat`.

```ts
import { chat } from 'xdev-ai'

const answer = await chat(
  { provider: 'openai', model: process.env.AI_MODEL!, apiKey: process.env.OPENAI_API_KEY },
  [{ role: 'user', content: 'Giải thích cách dùng AbortSignal.' }]
)
console.log(answer)
```

Extension VS Code khác có thể khai báo `"extensionDependencies": ["xdev.xdev-ai"]` và gọi API sau khi xDev AI đã được cài vào cùng extension host. `listAccounts()` trả về ID, tên, provider và model. Truyền `{ accountId }` để chọn hồ sơ cụ thể hoặc bỏ qua để dùng hồ sơ đang hoạt động.

```ts
const extension = vscode.extensions.getExtension('xdev.xdev-ai')
if (!extension) throw new Error('Cần cài xDev AI.')
const ai = await extension.activate()
const [account] = await ai.listAccounts()
if (account) {
  const answer = await ai.chat(
    [{ role: 'user', content: 'Giải thích đoạn mã này.' }],
    { accountId: account.id }
  )
}
```

## Build

```sh
npm ci
npm test
npm run package
```
