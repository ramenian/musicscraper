require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

// SAFETY CHECK
if (!process.env.MONGO_URI || !process.env.CLOUDINARY_CLOUD_NAME) {
    console.error("❌ FATAL ERROR: Missing Environment Variables!");
}

const app = express();
const PORT = process.env.PORT || 80;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: { folder: 'dj_music', resource_type: 'auto' }
});
const upload = multer({ storage: storage });

const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true },
    password: { type: String },
    contact: { type: String, unique: true },
    email: { type: String, default: '-' },
    phone: { type: String, default: '-' },
    tokens: { type: Number, default: 0 },
    profilePic: { type: String, default: '' },
    purchases: { type: Array, default: [] }
});
const User = mongoose.model('User', UserSchema);

const SongSchema = new mongoose.Schema({
    filename: String, filepath: String, size: Number, uploadTime: String, sequence: Number, price: { type: Number, default: 10 }
});
const Song = mongoose.model('Song', SongSchema);

const SettingsSchema = new mongoose.Schema({
    headerTitle: { type: String, default: 'DJ Music Library' }, bannerUrl: { type: String, default: '' }
});
const Settings = mongoose.model('Settings', SettingsSchema);

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.redirect('/music.html')); // Changed default to music.html for guests

// --- AUTH & USER API ---
app.post('/api/register', async (req, res) => {
    try {
        const { contact, username, password } = req.body;
        // CUSTOM ERROR EXACTLY AS REQUESTED
        const exists = await User.findOne({ $or: [{ username }, { contact }] });
        if (exists) return res.status(400).send('USER HAS BEEN REGISTERED');
        
        const isEmail = contact.includes('@');
        const newUser = new User({ contact, username, password, email: isEmail ? contact : '-', phone: isEmail ? '-' : contact });
        await newUser.save(); res.json({ success: true, username: newUser.username });
    } catch (e) { res.status(500).send('Server error'); }
});

app.post('/api/login', async (req, res) => {
    const { contact, password } = req.body;
    const user = await User.findOne({ $or: [{contact}, {username: contact}], password });
    if (user) res.json({ success: true, username: user.username }); else res.status(400).send('Invalid credentials.');
});

app.get('/api/users/:username', async (req, res) => {
    const user = await User.findOne({ username: req.params.username });
    if(user) res.json(user); else res.status(404).send('Not found');
});

app.get('/api/all-users', async (req, res) => {
    const users = await User.find({}, 'username email phone tokens'); res.json(users);
});

app.post('/api/users/:username/profile-pic', async (req, res) => {
    try {
        const user = await User.findOne({ username: req.params.username });
        if(!user) return res.status(404).send('Not found');
        const result = await cloudinary.uploader.upload(req.body.imageBase64, { folder: 'dj_profiles' });
        user.profilePic = result.secure_url; await user.save(); res.json({ profilePic: user.profilePic });
    } catch (e) { res.status(500).send('Upload failed'); }
});

app.put('/api/users/:username/change-username', async (req, res) => {
    const exists = await User.findOne({ username: req.body.newUsername });
    if (exists) return res.status(400).send('Username taken.');
    await User.findOneAndUpdate({ username: req.params.username }, { username: req.body.newUsername });
    res.json({ success: true, username: req.body.newUsername });
});
app.put('/api/users/:username/change-email', async (req, res) => { await User.findOneAndUpdate({ username: req.params.username }, { email: req.body.newEmail }); res.send('Updated'); });
app.put('/api/users/:username/change-phone', async (req, res) => { await User.findOneAndUpdate({ username: req.params.username }, { phone: req.body.newPhone }); res.send('Updated'); });
app.delete('/api/users/:username', async (req, res) => { await User.findOneAndDelete({ username: req.params.username }); res.send('Deleted'); });

app.post('/api/users/:username/topup', async (req, res) => {
    const user = await User.findOne({ username: req.params.username });
    if(!user) return res.status(404).send('Not found');
    user.tokens += req.body.amount; await user.save(); res.json({ tokens: user.tokens });
});

app.post('/api/users/:username/purchase', async (req, res) => {
    const song = await Song.findById(req.body.songId); if (!song) return res.status(404).send('Song not found');
    const user = await User.findOne({ username: req.params.username });
    if(user.purchases.find(p => p.songId === song.id)) return res.status(400).send('Already purchased');
    if(user.tokens >= song.price) {
        user.tokens -= song.price; user.purchases.push({ songId: song.id, songName: song.filename, filepath: song.filepath, tokensSpent: song.price });
        await user.save(); res.json({ success: true, tokens: user.tokens, purchases: user.purchases });
    } else res.status(400).send('Insufficient tokens');
});

app.post('/api/forgot-password', async (req, res) => {
    const { contact } = req.body; const user = await User.findOne({ $or: [{contact}, {email: contact}, {phone: contact}] });
    if (user) res.json({ success: true, resetToken: user.id }); else res.status(400).send('Not found.');
});
app.post('/api/reset-password', async (req, res) => {
    const user = await User.findById(req.body.token);
    if (user) { user.password = req.body.newPassword; await user.save(); res.send('Password reset.'); } else res.status(400).send('Invalid token.');
});

// --- 5. ADMIN / LIBRARY API ---
app.get('/api/settings', async (req, res) => res.json(await Settings.findOne()));
app.put('/api/settings', async (req, res) => { await Settings.findOneAndUpdate({}, { headerTitle: req.body.headerTitle }); res.send('Updated'); });
app.post('/api/upload-banner', upload.single('bannerFile'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file.');
    await Settings.findOneAndUpdate({}, { bannerUrl: req.file.path }); res.json(await Settings.findOne());
});

app.get('/api/songs', async (req, res) => { const songs = await Song.find().sort('sequence'); res.json(songs); });

app.post('/api/upload', upload.single('mp3file'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file.');
    const count = await Song.countDocuments();
    const newSong = new Song({ filename: Buffer.from(req.file.originalname, 'latin1').toString('utf8'), filepath: req.file.path, size: req.file.size, uploadTime: new Date().toISOString(), sequence: count + 1, price: 10 });
    await newSong.save(); res.json(newSong);
});

app.post('/api/transload', async (req, res) => {
    const { url } = req.body; if (!url || url.toLowerCase().includes('.html') || !url.toLowerCase().split('?')[0].endsWith('.m4a')) return res.status(400).send('Only .m4a URLs allowed.');
    try {
        const result = await cloudinary.uploader.upload(url, { resource_type: "auto", folder: "dj_music" });
        const count = await Song.countDocuments();
        const newSong = new Song({ filename: 'New Transloaded Track.m4a', filepath: result.secure_url, size: result.bytes, uploadTime: new Date().toISOString(), sequence: count + 1, price: 10 });
        await newSong.save(); res.json(newSong);
    } catch (error) { res.status(400).send('Transload failed.'); }
});

app.put('/api/songs/:id/settings', async (req, res) => {
    const song = await Song.findById(req.params.id);
    if (song) { 
        if (req.body.newName) { let n = req.body.newName; const ext = song.filename.includes('.m4a') ? '.m4a' : '.mp3'; if (!n.toLowerCase().endsWith(ext)) n += ext; song.filename = n; }
        if (req.body.newPrice !== undefined) song.price = parseInt(req.body.newPrice) || 0;
        await song.save(); res.send('Updated'); 
    } else res.status(404).send('Not found');
});

app.put('/api/songs/reorder', async (req, res) => {
    const promises = req.body.orderedIds.map((id, index) => Song.findByIdAndUpdate(id, { sequence: index + 1 }));
    await Promise.all(promises); res.send('Reordered');
});

app.delete('/api/songs/:id', async (req, res) => {
    await Song.findByIdAndDelete(req.params.id); 
    const songs = await Song.find().sort('sequence');
    await Promise.all(songs.map((s, i) => { s.sequence = i + 1; return s.save(); }));
    res.send('Deleted');
});

const startApp = async () => {
    app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server bound to 0.0.0.0 on Port ${PORT}`));
    if (process.env.MONGO_URI) {
        try {
            await mongoose.connect(process.env.MONGO_URI);
            console.log('✅ MongoDB Connected successfully');
            Settings.findOne().then(s => { if(!s) new Settings().save(); });
        } catch (err) { console.error('❌ MongoDB Connection Error', err.message); }
    }
};

startApp();
