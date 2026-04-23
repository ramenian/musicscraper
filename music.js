require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const admin = require('firebase-admin');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
const PORT = process.env.PORT || 80;

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(__dirname));

// --- 1. FIREBASE DATABASE INITIALIZATION ---
let db;
if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    console.error("❌ FATAL ERROR: Missing FIREBASE_SERVICE_ACCOUNT_JSON!");
} else {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        console.log('✅ Google Firebase (Database) Connected!');
        db = admin.firestore();
    } catch (error) {
        console.error('❌ Firebase Connection Error:', error.message);
    }
}

// --- 2. CLOUDINARY FILE STORAGE INITIALIZATION ---
if (!process.env.CLOUDINARY_CLOUD_NAME) {
    console.error("❌ FATAL ERROR: Missing Cloudinary Variables!");
} else {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
    });
    console.log('✅ Cloudinary (Storage) Connected!');
}

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: { folder: 'dj_music', resource_type: 'auto' }
});
const upload = multer({ storage: storage });

// --- 3. ROUTES ---
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'music.html')); });

// --- 4. AUTH & USER API (FIRESTORE) ---
app.post('/api/register', async (req, res) => {
    try {
        if(!db) return res.status(500).send('Database not connected.');
        const { contact, username, password } = req.body;
        
        const userRef = db.collection('users').doc(username.toLowerCase());
        const doc = await userRef.get();
        if (doc.exists) return res.status(400).send('USER HAS BEEN REGISTERED');

        const contactCheck = await db.collection('users').where('contact', '==', contact).get();
        if (!contactCheck.empty) return res.status(400).send('USER HAS BEEN REGISTERED');

        const isEmail = contact.includes('@');
        const userData = {
            username: username, contact: contact, password: password,
            email: isEmail ? contact : '-', phone: isEmail ? '-' : contact,
            tokens: 0, profilePic: '', purchases: [], createdAt: new Date().toISOString()
        };

        await userRef.set(userData);
        res.json({ success: true, username: username });
    } catch (e) { res.status(500).send('DB Error: ' + e.message); }
});

app.post('/api/login', async (req, res) => {
    try {
        if(!db) return res.status(500).send('Database not connected');
        const { contact, password } = req.body;
        let userDoc;
        
        const byUsername = await db.collection('users').doc(contact.toLowerCase()).get();
        if (byUsername.exists) userDoc = byUsername;
        else {
            const byContact = await db.collection('users').where('contact', '==', contact).get();
            if (!byContact.empty) userDoc = byContact.docs[0];
        }

        if (userDoc && userDoc.data().password === password) {
            res.json({ success: true, username: userDoc.data().username });
        } else {
            res.status(400).send('Invalid credentials.');
        }
    } catch (e) { res.status(500).send('DB Error: ' + e.message); }
});

app.get('/api/users/:username', async (req, res) => {
    if(!db) return res.status(500).send('Database not connected');
    const doc = await db.collection('users').doc(req.params.username.toLowerCase()).get();
    if (doc.exists) res.json(doc.data()); else res.status(404).send('Not found');
});

app.get('/api/all-users', async (req, res) => {
    if(!db) return res.json([]);
    try {
        const snapshot = await db.collection('users').get();
        const users = snapshot.docs.map(doc => {
            const data = doc.data();
            return { username: data.username, email: data.email, phone: data.phone, tokens: data.tokens || 0, profilePic: data.profilePic || '', purchases: data.purchases || [] };
        });
        res.json(users);
    } catch (e) { res.status(500).json([]); }
});

app.post('/api/users/:username/profile-pic', async (req, res) => {
    try {
        if(!db) return res.status(500).send('Database not connected');
        const userRef = db.collection('users').doc(req.params.username.toLowerCase());
        const doc = await userRef.get();
        if (!doc.exists) return res.status(404).send('Not found');

        const result = await cloudinary.uploader.upload(req.body.imageBase64, { folder: 'dj_profiles' });
        await userRef.update({ profilePic: result.secure_url });
        res.json({ profilePic: result.secure_url });
    } catch (e) { res.status(500).send('Upload Error: ' + e.message); }
});

app.put('/api/users/:username/change-username', async (req, res) => {
    try {
        if(!db) return res.status(500).send('Database not connected');
        const oldId = req.params.username.toLowerCase();
        const newId = req.body.newUsername.toLowerCase();
        
        const checkNew = await db.collection('users').doc(newId).get();
        if (checkNew.exists) return res.status(400).send('Username taken.');

        const oldRef = db.collection('users').doc(oldId);
        const doc = await oldRef.get();
        if (!doc.exists) return res.status(404).send('Not found');

        const data = doc.data();
        data.username = req.body.newUsername; 
        await db.collection('users').doc(newId).set(data);
        await oldRef.delete();

        res.json({ success: true, username: req.body.newUsername });
    } catch (e) { res.status(500).send('DB Error: ' + e.message); }
});

// ADMIN API: Update User Details & Tokens in one go
app.put('/api/admin/users/:username', async (req, res) => {
    try {
        if(!db) return res.status(500).send('Database not connected');
        const { tokens, email, phone } = req.body;
        const userRef = db.collection('users').doc(req.params.username.toLowerCase());
        await userRef.update({ tokens: Number(tokens), email: email, phone: phone });
        res.send('Updated');
    } catch (e) { res.status(500).send('DB Error: ' + e.message); }
});

app.delete('/api/users/:username', async (req, res) => {
    if(!db) return res.status(500).send('Database not connected');
    await db.collection('users').doc(req.params.username.toLowerCase()).delete(); res.send('Deleted');
});

app.post('/api/users/:username/topup', async (req, res) => {
    if(!db) return res.status(500).send('Database not connected');
    const userRef = db.collection('users').doc(req.params.username.toLowerCase());
    const doc = await userRef.get();
    if (!doc.exists) return res.status(404).send('Not found');
    const newTokens = (doc.data().tokens || 0) + req.body.amount;
    await userRef.update({ tokens: newTokens });
    res.json({ tokens: newTokens });
});

app.post('/api/users/:username/purchase', async (req, res) => {
    try {
        if(!db) return res.status(500).send('Database not connected');
        const { songId } = req.body;
        const songDoc = await db.collection('songs').doc(songId).get();
        if (!songDoc.exists) return res.status(404).send('Song not found');
        const song = songDoc.data();

        const userRef = db.collection('users').doc(req.params.username.toLowerCase());
        const userDoc = await userRef.get();
        if (!userDoc.exists) return res.status(404).send('User not found');
        const user = userDoc.data();

        user.purchases = user.purchases || [];
        if (user.purchases.find(p => p.songId === songId)) return res.status(400).send('Already purchased');

        const price = song.price !== undefined ? song.price : 10;
        if (user.tokens >= price) {
            user.tokens -= price;
            // Generate 10 char Alphanumeric ID and Timestamp
            const pId = Math.random().toString(36).substring(2, 12).toUpperCase();
            const pTime = new Date().toISOString();
            
            user.purchases.push({ songId: songId, songName: song.filename, filepath: song.filepath, tokensSpent: price, purchaseId: pId, purchaseTime: pTime });
            await userRef.update({ tokens: user.tokens, purchases: user.purchases });
            res.json({ success: true, tokens: user.tokens, purchases: user.purchases });
        } else res.status(400).send('Insufficient tokens');
    } catch (e) { res.status(500).send('DB Error: ' + e.message); }
});

app.post('/api/forgot-password', async (req, res) => {
    if(!db) return res.status(500).send('Database not connected');
    const { contact } = req.body; 
    let userQuery = await db.collection('users').where('contact', '==', contact).get();
    if(userQuery.empty) userQuery = await db.collection('users').where('email', '==', contact).get();
    if(userQuery.empty) userQuery = await db.collection('users').where('phone', '==', contact).get();
    if (!userQuery.empty) res.json({ success: true, resetToken: userQuery.docs[0].id }); else res.status(400).send('Not found.');
});
app.post('/api/reset-password', async (req, res) => {
    if(!db) return res.status(500).send('Database not connected');
    const userRef = db.collection('users').doc(req.body.token);
    const doc = await userRef.get();
    if (doc.exists) { await userRef.update({ password: req.body.newPassword }); res.send('Password reset.'); } else res.status(400).send('Invalid token.');
});

// --- 5. ADMIN / LIBRARY API ---
app.get('/api/settings', async (req, res) => {
    if(!db) return res.json({ headerTitle: 'DJ Music Library', bannerUrl: '' });
    const doc = await db.collection('settings').doc('global').get();
    res.json(doc.exists ? doc.data() : { headerTitle: 'DJ Music Library', bannerUrl: '' });
});

app.put('/api/settings', async (req, res) => {
    if(!db) return res.status(500).send('Database not connected');
    await db.collection('settings').doc('global').set({ headerTitle: req.body.headerTitle }, { merge: true }); res.send('Updated');
});

app.post('/api/upload-banner', upload.single('bannerFile'), async (req, res) => {
    if(!db) return res.status(500).send('Database not connected');
    if (!req.file) return res.status(400).send('No file.');
    try {
        await db.collection('settings').doc('global').set({ bannerUrl: req.file.path }, { merge: true });
        const doc = await db.collection('settings').doc('global').get();
        res.json(doc.data());
    } catch (e) { res.status(500).send('Upload Error: ' + e.message); }
});

app.get('/api/songs', async (req, res) => {
    if(!db) return res.json([]);
    try {
        const snapshot = await db.collection('songs').orderBy('sequence').get();
        const songs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.json(songs);
    } catch(e) { res.status(500).json([]); }
});

app.post('/api/upload', upload.single('mp3file'), async (req, res) => {
    if(!db) return res.status(500).send('Database not connected');
    if (!req.file) return res.status(400).send('No file.');
    try {
        const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
        const snapshot = await db.collection('songs').get();
        const newSong = { filename: originalName, filepath: req.file.path, size: req.file.size, uploadTime: new Date().toISOString(), sequence: snapshot.size + 1, price: 10 };
        const docRef = await db.collection('songs').add(newSong);
        res.json({ id: docRef.id, ...newSong });
    } catch (e) { res.status(500).send('Upload Error: ' + e.message); }
});

app.post('/api/transload', async (req, res) => {
    if(!db) return res.status(500).send('Database not connected');
    const { url } = req.body; 
    if (!url || url.toLowerCase().includes('.html') || !url.toLowerCase().split('?')[0].endsWith('.m4a')) return res.status(400).send('Only .m4a URLs allowed.');
    try {
        const result = await cloudinary.uploader.upload(url, { resource_type: "auto", folder: "dj_music" });
        const snapshot = await db.collection('songs').get();
        const newSong = { filename: 'New Transloaded Track.m4a', filepath: result.secure_url, size: result.bytes, uploadTime: new Date().toISOString(), sequence: snapshot.size + 1, price: 10 };
        const docRef = await db.collection('songs').add(newSong);
        res.json({ id: docRef.id, ...newSong });
    } catch (error) { res.status(400).send('Transload Error: ' + error.message); }
});

app.put('/api/songs/:id/settings', async (req, res) => {
    if(!db) return res.status(500).send('Database not connected');
    const songRef = db.collection('songs').doc(req.params.id);
    const doc = await songRef.get();
    if (!doc.exists) return res.status(404).send('Not found');
    
    let updates = {};
    if (req.body.newName) { let n = req.body.newName; const ext = doc.data().filename.includes('.m4a') ? '.m4a' : '.mp3'; if (!n.toLowerCase().endsWith(ext)) n += ext; updates.filename = n; }
    if (req.body.newPrice !== undefined) updates.price = parseInt(req.body.newPrice) || 0;
    
    await songRef.update(updates); res.send('Updated');
});

app.put('/api/songs/reorder', async (req, res) => {
    if(!db) return res.status(500).send('Database not connected');
    const batch = db.batch();
    req.body.orderedIds.forEach((id, index) => { const ref = db.collection('songs').doc(id); batch.update(ref, { sequence: index + 1 }); });
    await batch.commit(); res.send('Reordered');
});

app.delete('/api/songs/:id', async (req, res) => {
    if(!db) return res.status(500).send('Database not connected');
    const songRef = db.collection('songs').doc(req.params.id);
    const doc = await songRef.get();
    if (!doc.exists) return res.status(404).send('Not found');

    await songRef.delete();
    const snapshot = await db.collection('songs').orderBy('sequence').get();
    const batch = db.batch();
    snapshot.docs.forEach((d, i) => batch.update(d.ref, { sequence: i + 1 }));
    await batch.commit();
    res.send('Deleted');
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server successfully bound to 0.0.0.0 on Port ${PORT}`));
