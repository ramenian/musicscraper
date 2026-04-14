const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 80;
const DATA_FILE = path.join(__dirname, 'data.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOADS_DIR));

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([]));
if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ headerTitle: "DJ Music Library", bannerUrl: "" }));
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify([]));

app.get('/', (req, res) => res.redirect('/register.html'));

function getSongs() {
    let songs = [];
    try {
        const rawData = fs.readFileSync(DATA_FILE, 'utf8');
        songs = JSON.parse(rawData);
        if (!Array.isArray(songs)) songs = [];
    } catch (e) { songs = []; }
    return songs.sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
}

function getUsers() {
    try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } 
    catch (e) { return []; }
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        const safeName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        cb(null, Date.now() + '-' + safeName);
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: (req, file, cb) => {
        const isAudio = file.mimetype.includes('audio') || file.originalname.endsWith('.mp3') || file.originalname.endsWith('.m4a');
        const isImage = file.mimetype.includes('image');
        if (isAudio || isImage) cb(null, true);
        else cb(new Error('Invalid file type.'));
    }
});

// --- AUTH & USER API ---
app.post('/api/register', (req, res) => {
    const { contact, username, password } = req.body; 
    let users = getUsers();
    if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) return res.status(400).send('Username taken.');
    if (users.find(u => u.contact.toLowerCase() === contact.toLowerCase())) return res.status(400).send('Email/Phone registered.');
    
    const isEmail = contact.includes('@');
    const email = isEmail ? contact : '-';
    const phone = isEmail ? '-' : contact;

    const newUser = { id: Date.now().toString(), contact, email, phone, username, password, tokens: 0, purchases: [], profilePic: '' };
    users.push(newUser); fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); res.json({ success: true, username: newUser.username });
});

app.post('/api/login', (req, res) => {
    const { contact, password } = req.body; let users = getUsers();
    const user = users.find(u => (u.contact === contact || u.username === contact) && u.password === password);
    if (user) res.json({ success: true, username: user.username }); else res.status(400).send('Invalid credentials.');
});

app.get('/api/users/:username', (req, res) => {
    const user = getUsers().find(u => u.username === req.params.username);
    if(user) {
        res.json({ 
            username: user.username, tokens: user.tokens || 0, purchases: user.purchases || [],
            profilePic: user.profilePic || '', email: user.email || '-', phone: user.phone || '-'
        });
    } else res.status(404).send('User not found');
});

// --- NEW API: FETCH ALL USERS FOR MANAGER ---
app.get('/api/all-users', (req, res) => {
    const users = getUsers().map(u => ({
        username: u.username,
        email: u.email && u.email !== '-' ? u.email : '-',
        phone: u.phone && u.phone !== '-' ? u.phone : '-',
        tokens: u.tokens || 0
    }));
    res.json(users);
});
// ---------------------------------------------

app.post('/api/users/:username/profile-pic', (req, res) => {
    const { imageBase64 } = req.body; let users = getUsers(); let user = users.find(u => u.username === req.params.username);
    if(user) {
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, ""); const filename = 'profile-' + Date.now() + '.png';
        fs.writeFileSync(path.join(__dirname, 'uploads', filename), base64Data, 'base64');
        user.profilePic = '/uploads/' + filename; fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); res.json({ profilePic: user.profilePic });
    } else res.status(404).send('User not found');
});

app.put('/api/users/:username/change-username', (req, res) => {
    const { newUsername } = req.body; let users = getUsers();
    if (users.find(u => u.username.toLowerCase() === newUsername.toLowerCase())) return res.status(400).send('Username already taken.');
    let user = users.find(u => u.username === req.params.username);
    if(user) { user.username = newUsername; fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); res.json({ success: true, username: newUsername }); } else res.status(404).send('User not found');
});

app.put('/api/users/:username/change-email', (req, res) => {
    const { newEmail } = req.body; let users = getUsers(); let user = users.find(u => u.username === req.params.username);
    if(user) { user.email = newEmail; fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); res.send('Email updated'); } else res.status(404).send('User not found');
});

app.put('/api/users/:username/change-phone', (req, res) => {
    const { newPhone } = req.body; let users = getUsers(); let user = users.find(u => u.username === req.params.username);
    if(user) { user.phone = newPhone; fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); res.send('Phone updated'); } else res.status(404).send('User not found');
});

app.delete('/api/users/:username', (req, res) => {
    let users = getUsers(); const userIndex = users.findIndex(u => u.username === req.params.username);
    if(userIndex !== -1) { users.splice(userIndex, 1); fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); res.send('Account deleted'); } else res.status(404).send('User not found');
});

app.post('/api/users/:username/topup', (req, res) => {
    let users = getUsers(); let user = users.find(u => u.username === req.params.username);
    if(user) { user.tokens = (user.tokens || 0) + req.body.amount; fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); res.json({ tokens: user.tokens }); } else res.status(404).send('User not found');
});

app.post('/api/users/:username/purchase', (req, res) => {
    const { songId } = req.body; let songs = getSongs(); const song = songs.find(s => s.id === songId);
    if (!song) return res.status(404).send('Song not found');
    let users = getUsers(); let user = users.find(u => u.username === req.params.username);
    if(user) {
        user.tokens = user.tokens || 0; user.purchases = user.purchases || [];
        if(user.purchases.find(p => p.songId === songId)) return res.status(400).send('Already purchased');
        const price = song.price !== undefined ? song.price : 10;
        if(user.tokens >= price) {
            user.tokens -= price; user.purchases.push({ songId: song.id, songName: song.filename, filepath: song.filepath, tokensSpent: price });
            fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); res.json({ success: true, tokens: user.tokens, purchases: user.purchases });
        } else res.status(400).send('Insufficient tokens');
    } else res.status(404).send('User not found');
});

app.post('/api/forgot-password', (req, res) => {
    const { contact } = req.body; let users = getUsers(); const user = users.find(u => u.contact === contact || u.email === contact || u.phone === contact);
    if (user) res.json({ success: true, resetToken: user.id }); else res.status(400).send('Account not found.');
});
app.post('/api/reset-password', (req, res) => {
    const { token, newPassword } = req.body; let users = getUsers(); const userIndex = users.findIndex(u => u.id === token);
    if (userIndex !== -1) { users[userIndex].password = newPassword; fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); res.send('Password reset successfully.'); } else res.status(400).send('Invalid reset token.');
});

// Admin / Library APIs
app.get('/api/settings', (req, res) => res.json(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))));
app.put('/api/settings', (req, res) => { let settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); settings.headerTitle = req.body.headerTitle; fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); res.send('Settings updated'); });
app.post('/api/upload-banner', upload.single('bannerFile'), (req, res) => { if (!req.file) return res.status(400).send('No file uploaded.'); let settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); settings.bannerUrl = '/uploads/' + req.file.filename; fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); res.json(settings); });
app.get('/api/songs', (req, res) => res.json(getSongs()));

app.post('/api/upload', (req, res) => {
    upload.single('mp3file')(req, res, function (err) {
        if (err) return res.status(400).send(err.message); if (!req.file) return res.status(400).send('No file uploaded.');
        let songs = getSongs(); const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
        const newSong = { id: Date.now().toString(), filename: originalName, filepath: '/uploads/' + req.file.filename, size: req.file.size, uploadTime: new Date().toISOString(), sequence: songs.length + 1, price: 10 };
        songs.push(newSong); fs.writeFileSync(DATA_FILE, JSON.stringify(songs, null, 2)); res.json(newSong);
    });
});

app.post('/api/transload', async (req, res) => {
    const { url } = req.body; if (!url || url.toLowerCase().includes('.html') || !url.toLowerCase().split('?')[0].endsWith('.m4a')) return res.status(400).send('Only .m4a request URLs allowed.');
    try {
        const response = await fetch(url); if (!response.ok) throw new Error(`HTTP Error`);
        const filename = 'transload-' + Date.now() + '.m4a'; const filepath = path.join(__dirname, 'uploads', filename);
        const buffer = await response.arrayBuffer(); fs.writeFileSync(filepath, Buffer.from(buffer));
        let songs = getSongs(); const newSong = { id: Date.now().toString(), filename: 'New Track.m4a', filepath: '/uploads/' + filename, size: buffer.byteLength, uploadTime: new Date().toISOString(), sequence: songs.length + 1, price: 10 };
        songs.push(newSong); fs.writeFileSync(DATA_FILE, JSON.stringify(songs, null, 2)); res.json(newSong);
    } catch (error) { res.status(400).send('Failed to download.'); }
});

app.put('/api/songs/:id/settings', (req, res) => {
    let songs = getSongs(); const song = songs.find(s => s.id === req.params.id);
    if (song) { 
        if (req.body.newName) { let newName = req.body.newName; const ext = song.filename.includes('.m4a') ? '.m4a' : '.mp3'; if (!newName.toLowerCase().endsWith(ext)) newName += ext; song.filename = newName; }
        if (req.body.newPrice !== undefined) song.price = parseInt(req.body.newPrice) || 0;
        fs.writeFileSync(DATA_FILE, JSON.stringify(songs, null, 2)); res.send('Settings updated'); 
    } else res.status(404).send('Not found');
});

app.put('/api/songs/reorder', (req, res) => { let songs = getSongs(); req.body.orderedIds.forEach((id, index) => { const song = songs.find(s => s.id === id); if (song) song.sequence = index + 1; }); fs.writeFileSync(DATA_FILE, JSON.stringify(songs, null, 2)); res.send('Reordered'); });
app.delete('/api/songs/:id', (req, res) => { let songs = getSongs(); const songIndex = songs.findIndex(s => s.id === req.params.id); if(songIndex !== -1) { const fullPath = path.join(__dirname, songs[songIndex].filepath); if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); songs.splice(songIndex, 1); songs.forEach((s, i) => s.sequence = i + 1); fs.writeFileSync(DATA_FILE, JSON.stringify(songs, null, 2)); res.send('Deleted'); } else res.status(404).send('Not found'); });

app.listen(PORT, () => console.log(`Server running`));
