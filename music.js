require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 80;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// --- CLOUD CONNECTIONS ---
// 1. Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('✅ MongoDB Connected Globally'))
    .catch(err => console.log('❌ MongoDB Error:', err));

// 2. Connect to Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// 3. Set up Multer to upload directly to Cloudinary
const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'dj_music_uploads',
        resource_type: 'auto' // automatically handles images, mp3s, m4as
    }
});
const upload = multer({ storage: storage });

// --- DATABASE SCHEMAS ---
const settingSchema = new mongoose.Schema({ id: String, headerTitle: String, bannerUrl: String });
const Setting = mongoose.model('Setting', settingSchema);

const songSchema = new mongoose.Schema({
    id: String, filename: String, filepath: String, size: Number, uploadTime: String, sequence: Number, price: { type: Number, default: 10 }
});
const Song = mongoose.model('Song', songSchema);

const userSchema = new mongoose.Schema({
    id: String, contact: String, email: String, phone: String, username: String, password: String,
    tokens: { type: Number, default: 0 }, purchases: Array, profilePic: String
});
const User = mongoose.model('User', userSchema);

// Ensure Settings exist
async function initSettings() {
    const s = await Setting.findOne({ id: 'main' });
    if (!s) await Setting.create({ id: 'main', headerTitle: 'DJ Music Library', bannerUrl: '' });
}
initSettings();

// --- ROUTING ---
app.get('/', (req, res) => res.redirect('/register.html'));

// AUTH & USER API
app.post('/api/register', async (req, res) => {
    const { contact, username, password } = req.body; 
    
    const userExist = await User.findOne({ username: new RegExp(`^${username}$`, 'i') });
    if (userExist) return res.status(400).send('Username taken.');
    
    const contactExist = await User.findOne({ contact: new RegExp(`^${contact}$`, 'i') });
    if (contactExist) return res.status(400).send('Email/Phone registered.');
    
    const isEmail = contact.includes('@');
    const newUser = new User({
        id: Date.now().toString(), contact, email: isEmail ? contact : '-', phone: isEmail ? '-' : contact,
        username, password, tokens: 0, purchases: [], profilePic: ''
    });
    await newUser.save();
    res.json({ success: true, username: newUser.username });
});

app.post('/api/login', async (req, res) => {
    const { contact, password } = req.body;
    const user = await User.findOne({ $or: [{contact}, {username: contact}], password });
    if (user) res.json({ success: true, username: user.username }); 
    else res.status(400).send('Invalid credentials.');
});

app.get('/api/users/:username', async (req, res) => {
    const user = await User.findOne({ username: req.params.username });
    if(user) res.json(user); else res.status(404).send('User not found');
});

app.get('/api/all-users', async (req, res) => {
    const users = await User.find();
    res.json(users.map(u => ({ username: u.username, email: u.email, phone: u.phone, tokens: u.tokens })));
});

// Profile Pic (Base64 to Cloudinary)
app.post('/api/users/:username/profile-pic', async (req, res) => {
    const user = await User.findOne({ username: req.params.username });
    if(!user) return res.status(404).send('User not found');
    try {
        const uploadRes = await cloudinary.uploader.upload(req.body.imageBase64, { folder: 'dj_music_profiles' });
        user.profilePic = uploadRes.secure_url;
        await user.save();
        res.json({ profilePic: user.profilePic });
    } catch(err) { res.status(500).send('Upload failed'); }
});

// User Editing
app.put('/api/users/:username/change-username', async (req, res) => {
    const exist = await User.findOne({ username: new RegExp(`^${req.body.newUsername}$`, 'i') });
    if (exist) return res.status(400).send('Username already taken.');
    const user = await User.findOneAndUpdate({ username: req.params.username }, { username: req.body.newUsername }, {new: true});
    if(user) res.json({ success: true, username: user.username }); else res.status(404).send('Not found');
});
app.put('/api/users/:username/change-email', async (req, res) => {
    await User.findOneAndUpdate({ username: req.params.username }, { email: req.body.newEmail }); res.send('Updated');
});
app.put('/api/users/:username/change-phone', async (req, res) => {
    await User.findOneAndUpdate({ username: req.params.username }, { phone: req.body.newPhone }); res.send('Updated');
});
app.delete('/api/users/:username', async (req, res) => {
    await User.findOneAndDelete({ username: req.params.username }); res.send('Deleted');
});

// Economy
app.post('/api/users/:username/topup', async (req, res) => {
    const user = await User.findOne({ username: req.params.username });
    if(user) { user.tokens += req.body.amount; await user.save(); res.json({ tokens: user.tokens }); } 
    else res.status(404).send('User not found');
});

app.post('/api/users/:username/purchase', async (req, res) => {
    const song = await Song.findOne({ id: req.body.songId });
    if (!song) return res.status(404).send('Song not found');
    const user = await User.findOne({ username: req.params.username });
    if(user) {
        if(user.purchases.find(p => p.songId === song.id)) return res.status(400).send('Already purchased');
        if(user.tokens >= song.price) {
            user.tokens -= song.price;
            user.purchases.push({ songId: song.id, songName: song.filename, filepath: song.filepath, tokensSpent: song.price });
            await user.save();
            res.json({ success: true, tokens: user.tokens, purchases: user.purchases });
        } else res.status(400).send('Insufficient tokens');
    } else res.status(404).send('User not found');
});

// Passwords
app.post('/api/forgot-password', async (req, res) => {
    const user = await User.findOne({ $or: [{contact: req.body.contact}, {email: req.body.contact}, {phone: req.body.contact}] });
    if (user) res.json({ success: true, resetToken: user.id }); else res.status(400).send('Not found.');
});
app.post('/api/reset-password', async (req, res) => {
    const user = await User.findOneAndUpdate({ id: req.body.token }, { password: req.body.newPassword });
    if(user) res.send('Success'); else res.status(400).send('Invalid token.');
});

// Settings & Admin
app.get('/api/settings', async (req, res) => {
    const s = await Setting.findOne({ id: 'main' }); res.json(s || {});
});
app.put('/api/settings', async (req, res) => {
    await Setting.findOneAndUpdate({ id: 'main' }, { headerTitle: req.body.headerTitle }); res.send('Updated');
});
app.post('/api/upload-banner', upload.single('bannerFile'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');
    const s = await Setting.findOneAndUpdate({ id: 'main' }, { bannerUrl: req.file.path }, {new: true});
    res.json(s);
});

// Songs API
app.get('/api/songs', async (req, res) => {
    const songs = await Song.find().sort({ sequence: 1 }); res.json(songs);
});

app.post('/api/upload', upload.single('mp3file'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');
    const count = await Song.countDocuments();
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const newSong = new Song({
        id: Date.now().toString(), filename: originalName, filepath: req.file.path, // req.file.path is now the Cloudinary URL!
        size: req.file.size, uploadTime: new Date().toISOString(), sequence: count + 1, price: 10
    });
    await newSong.save(); res.json(newSong);
});

app.post('/api/transload', async (req, res) => {
    const { url } = req.body;
    if (!url || url.toLowerCase().includes('.html') || !url.toLowerCase().split('?')[0].endsWith('.m4a')) return res.status(400).send('Only .m4a allowed.');
    try {
        // Cloudinary native transload from URL
        const uploadRes = await cloudinary.uploader.upload(url, { resource_type: 'video', folder: 'dj_music_uploads' });
        const count = await Song.countDocuments();
        const newSong = new Song({
            id: Date.now().toString(), filename: 'Transloaded Track.m4a', filepath: uploadRes.secure_url,
            size: uploadRes.bytes, uploadTime: new Date().toISOString(), sequence: count + 1, price: 10
        });
        await newSong.save(); res.json(newSong);
    } catch (error) { res.status(400).send('Failed to download.'); }
});

app.put('/api/songs/:id/settings', async (req, res) => {
    const song = await Song.findOne({ id: req.params.id });
    if(song) {
        if (req.body.newName) {
            let newName = req.body.newName; const ext = song.filename.includes('.m4a') ? '.m4a' : '.mp3';
            if (!newName.toLowerCase().endsWith(ext)) newName += ext; song.filename = newName;
        }
        if (req.body.newPrice !== undefined) song.price = parseInt(req.body.newPrice) || 0;
        await song.save(); res.send('Updated');
    } else res.status(404).send('Not found');
});

app.put('/api/songs/reorder', async (req, res) => {
    const ops = req.body.orderedIds.map((id, index) => ({ updateOne: { filter: { id }, update: { sequence: index + 1 } } }));
    await Song.bulkWrite(ops); res.send('Reordered');
});

app.delete('/api/songs/:id', async (req, res) => {
    await Song.findOneAndDelete({ id: req.params.id }); res.send('Deleted');
});
app.post('/api/songs/bulk-delete', async (req, res) => {
    await Song.deleteMany({ id: { $in: req.body.ids } }); res.send('Deleted');
});

app.listen(PORT, () => console.log(`Server running safely on port ${PORT}`));
