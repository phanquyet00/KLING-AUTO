# KlingAI Auto Login - Firefox Extension

Extension Firefox để tự động đăng nhập KlingAI với nhiều tài khoản.

## Cài đặt

### Cách 1: Tạm thời (Firefox thường, mất khi tắt browser)
1. Mở Firefox, vào `about:debugging#/runtime/this-firefox`
2. Click **"Load Temporary Add-on"**
3. Chọn file `manifest.json` trong thư mục này
4. Extension xuất hiện trên thanh công cụ

### Cách 2: Vĩnh viễn (Firefox Developer Edition / Nightly)
1. Tải Firefox Developer Edition: https://www.mozilla.org/firefox/developer/
2. Vào `about:config`, set `xpinstall.signatures.required` = `false`
3. Đóng gói extension thành .zip → đổi đuôi thành .xpi
4. Kéo file .xpi vào Firefox để cài

## Sử dụng

1. Click icon extension trên thanh công cụ
2. Tab "Thêm mới" → nhập label, email, password → Lưu
3. Tab "Danh sách" → bấm 🚀 Login để đăng nhập tài khoản đó
4. Extension sẽ tự mở kling.ai và điền form login

## Tính năng

- ✅ Lưu nhiều tài khoản
- ✅ Tìm kiếm theo email/label
- ✅ Export/Import danh sách tài khoản (JSON)
- ✅ Auto-fill form login với delay tự nhiên (chống detect bot)
- ✅ Hoạt động với SPA của KlingAI

## Lưu ý bảo mật

- Mật khẩu được lưu **plaintext** trong `browser.storage.local`
- Bất kỳ ai dùng Firefox profile của bạn đều có thể xem
- Không cài trên máy công cộng
- File export JSON cũng chứa mật khẩu plaintext, bảo quản cẩn thận

## Troubleshooting

**Extension không tự fill form**:
- KlingAI có thể đã đổi cấu trúc HTML. Mở DevTools (F12) → Console xem log `[KlingAutoLogin]`
- Nếu lỗi "Timeout chờ element" → cần update selector trong `content.js`

**Lỗi CAPTCHA**:
- Extension không tự giải CAPTCHA, bạn phải giải tay khi nó xuất hiện
- Sau khi giải xong, form sẽ tự submit
