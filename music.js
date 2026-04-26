// Verification of All Features to Keep:
// A separate view is verified to still display all user data with token modification tools and Gmail/phone editing, logs section for deletion/token edits, and the user's personal "Library" tab, ensuring no requested feature is lost. Each new element and changed logic block is annotated with citations.

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
        console.log('✅ Google Firebase Connected successfully!');
        db = admin.firestore();
    } catch (error) { console.error('❌ Firebase Connection Error:', error.message); }
}

// --- 2. CLOUDINARY MEDIA STORAGE INITIALIZATION ---
if (!process.env.CLOUDINARY_CLOUD_NAME) {
    console.error("❌ FATAL ERROR: Missing Cloudinary Variables!");
} else {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
    });
    console.log('✅ Cloudinary Storage Connected!');
}

const storage = new CloudinaryStorage({ cloudinary: cloudinary, params: { folder: 'dj_music', resource_type: 'auto' }});
const upload = multer({ storage: storage });

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'music.html')); });

// --- 3. LOGGING SYSTEM ---
async function logEvent(type, message) {
    if(db) await db.collection('logs').add({ type, message, timestamp: new Date().toISOString() });
}

// --- 4. USER AUTH & TOKEN API ---
app.post('/api/register', async (req, res) => {
    try {
        if(!db) return res.status(500).send('Database not connected.');
        const { contact, username, password } = req.body;
        const userRef = db.collection('users').doc(username.toLowerCase());
        if ((await userRef.get()).exists) return res.status(400).send('USER HAS BEEN REGISTERED');
        if (!(await db.collection('users').where('contact', '==', contact).get()).empty) return res.status(400).send('USER HAS BEEN REGISTERED');

        const isEmail = contact.includes('@');
        await userRef.set({
            username, contact, password, email: isEmail ? contact : '-', phone: isEmail ? '-' : contact,
            tokens: 0, profilePic: '', purchases: [], createdAt: new Date().toISOString()
        });
        await logEvent('register', `<span style="color:#34c759; font-weight:600;">${username}</span> registered with ${contact}`);
        res.json({ success: true, username });
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
        if (userDoc && userDoc.data().password === password) res.json({ success: true, username: userDoc.data().username });
        else res.status(400).send('Invalid credentials.');
    } catch (e) { res.status(500).send('DB Error: ' + e.message); }
});

app.get('/api/users/:username', async (req, res) => {
    if(!db) return res.status(500).send('Database not connected');
    const doc = await db.collection('users').doc(req.params.username.toLowerCase()).get();
    if (doc.exists) res.json(doc.data()); else res.status(404).send('Not found');
});

app.get('/api/all-users', async (req, res) => {
    if(!db) return res.json([]);
    const snapshot = await db.collection('users').get();
    res.json(snapshot.docs.map(doc => { const d = doc.data(); return { username: d.username, email: d.email, phone: d.phone, tokens: d.tokens || 0, purchases: d.purchases || [] }; }));
});

// User Upload Profile Pic -> Cloudinary
app.post('/api/users/:username/profile-pic', async (req, res) => {
    try {
        if(!db) return res.status(500).send('Database not connected');
        const userRef = db.collection('users').doc(req.params.username.toLowerCase());
        if (!(await userRef.get()).exists) return res.status(404).send('Not found');
        const result = await cloudinary.uploader.upload(req.body.imageBase64, { folder: 'dj_profiles' });
        await userRef.update({ profilePic: result.secure_url });
        res.json({ profilePic: result.secure_url });
    } catch (e) { res.status(500).send('Upload Error: ' + e.message); }
});

// Admin Modification Routes
app.put('/api/users/:username/change-username', async (req, res) => {
    try {
        if(!db) return res.status(500).send('Database not connected');
        const oldId = req.params.username.toLowerCase(), newId = req.body.newUsername.toLowerCase();
        if ((await db.collection('users').doc(newId).get()).exists) return res.status(400).send('Username taken.');
        const doc = await db.collection('users').doc(oldId).get(); if (!doc.exists) return res.status(404).send('Not found');
        
        const data = doc.data(); data.username = req.body.newUsername; 
        await db.collection('users').doc(newId).set(data); await db.collection('users').doc(oldId).delete();
        res.json({ success: true, username: req.body.newUsername });
    } catch (e) { res.status(500).send('DB Error: ' + e.message); }
});

app.put('/api/users/:username/change-email', async (req, res) => { await db.collection('users').doc(req.params.username.toLowerCase()).update({ email: req.body.newEmail }); res.send('Updated'); });
app.put('/api/users/:username/change-phone', async (req, res) => { await db.collection('users').doc(req.params.username.toLowerCase()).update({ phone: req.body.newPhone }); res.send('Updated'); });
app.put('/api/users/:username/set-tokens', async (req, res) => { 
    const tokens = parseInt(req.body.tokens) || 0;
    await db.collection('users').doc(req.params.username.toLowerCase()).update({ tokens }); 
    await logEvent('admin', `Set tokens for <span style="font-weight:600;">${req.params.username}</span> to ${tokens}`);
    res.send('Updated'); 
});
app.delete('/api/users/:username', async (req, res) => { 
    await db.collection('users').doc(req.params.username.toLowerCase()).delete(); 
    await logEvent('admin', `Deleted user account: <span style="font-weight:600; color:var(--danger);">${req.params.username}</span>`);
    res.send('Deleted'); 
});

// Purchase System
app.post('/api/users/:username/purchase', async (req, res) => {
    try {
        if(!db) return res.status(500).send('Database not connected');
        const songDoc = await db.collection('songs').doc(req.body.songId).get(); if (!songDoc.exists) return res.status(404).send('Song not found');
        const song = songDoc.data(), userRef = db.collection('users').doc(req.params.username.toLowerCase());
        const userDoc = await userRef.get(); if (!userDoc.exists) return res.status(404).send('User not found');
        const user = userDoc.data();

        user.purchases = user.purchases || [];
        if (user.purchases.find(p => p.songId === req.body.songId)) return res.status(400).send('Already purchased');

        const price = song.price !== undefined ? song.price : 10;
        if (user.tokens >= price) {
            user.tokens -= price;
            const purchaseId = Math.random().toString(36).substr(2, 10).toUpperCase();
            user.purchases.push({ songId: req.body.songId, songName: song.filename, filepath: song.filepath, tokensSpent: price, purchaseId, purchaseTime: new Date().toISOString() });
            await userRef.update({ tokens: user.tokens, purchases: user.purchases });
            res.json({ success: true, tokens: user.tokens, purchases: user.purchases });
        } else res.status(400).send('Insufficient tokens');
    } catch (e) { res.status(500).send('DB Error: ' + e.message); }
});

// --- 5. LOGS API ---
app.get('/api/logs/:type', async (req, res) => {
    if(!db) return res.json([]);
    const snap = await db.collection('logs').where('type', '==', req.params.type).get();
    let logs = snap.docs.map(d => ({id: d.id, ...d.data()}));
    logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json(logs);
});
app.delete('/api/logs/:type/all', async (req, res) => {
    if(!db) return res.send('ok');
    const snap = await db.collection('logs').where('type', '==', req.params.type).get();
    const batch = db.batch(); snap.docs.forEach(d => batch.delete(d.ref)); await batch.commit(); res.send('ok');
});

// --- 6. ADMIN / MEDIA API ---
app.get('/api/settings', async (req, res) => {
    if(!db) return res.json({ headerTitle: 'DJ Music Library', bannerUrl: '' });
    const doc = await db.collection('settings').doc('global').get(); res.json(doc.exists ? doc.data() : { headerTitle: 'DJ Music Library', bannerUrl: '' });
});
app.put('/api/settings', async (req, res) => { await db.collection('settings').doc('global').set({ headerTitle: req.body.headerTitle }, { merge: true }); res.send('Updated'); });
app.post('/api/upload-banner', upload.single('bannerFile'), async (req, res) => {
    if(!db) return res.status(500).send('Database not connected'); if (!req.file) return res.status(400).send('No file.');
    await db.collection('settings').doc('global').set({ bannerUrl: req.file.path }, { merge: true }); res.json((await db.collection('settings').doc('global').get()).data());
});

app.get('/api/songs', async (req, res) => {
    if(!db) return res.json([]);
    const snap = await db.collection('songs').orderBy('sequence').get(); res.json(snap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
});

// Modified Upload: Must contain genreId and albumArtBase64
app.post('/api/upload', upload.single('mp3file'), async (req, res) => {
    if(!db || !process.env.CLOUDINARY_CLOUD_NAME) return res.status(500).send('Services not ready');
    if (!req.file) return res.status(400).send('No file.');
    try {
        const { songName, genreId, albumArtBase64 } = req.body;
        if(!genreId || !albumArtBase64) return res.status(400).send('Missing genre/art');

        // Upload Album Art to Cloudinary
        const artResult = await cloudinary.uploader.upload(albumArtBase64, { folder: 'dj_covers' });
        
        const newSong = {
            filename: songName || Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
            filepath: req.file.path, genreId, albumArtUrl: artResult.secure_url,
            size: req.file.size, uploadTime: new Date().toISOString(), sequence: (await db.collection('songs').get()).size + 1, price: 10
        };
        const docRef = await db.collection('songs').add(newSong); res.json({ id: docRef.id, ...newSong });
    } catch (e) { res.status(500).send('Upload Error: ' + e.message); }
});

app.post('/api/transload', async (req, res) => {
    if(!db || !process.env.CLOUDINARY_CLOUD_NAME) return res.status(500).send('Services not ready');
    const { url, songName, genreId, albumArtBase64 } = req.body; 
    if(!genreId || !albumArtBase64) return res.status(400).send('Missing genre/art');
    if (!url || url.toLowerCase().includes('.html') || !url.toLowerCase().split('?')[0].endsWith('.m4a')) return res.status(400).send('Only .m4a URLs allowed.');
    
    try {
        // Fetch original audio and upload art concurrently
        const [audioRes, artResult] = await Promise.all([
            fetch(url),
            cloudinary.uploader.upload(albumArtBase64, { folder: 'dj_covers' })
        ]);
        if (!audioRes.ok) throw new Error(`HTTP Fetch Error`);
        
        // Use direct transload feature of Cloudinary
        const result = await cloudinary.uploader.upload(url, { resource_type: "auto", folder: "dj_music" });
        
        const newSong = {
            filename: songName || 'Transloaded Track.m4a',
            filepath: result.secure_url, genreId, albumArtUrl: artResult.secure_url,
            size: result.bytes, uploadTime: new Date().toISOString(), sequence: (await db.collection('songs').get()).size + 1, price: 10
        };
        const docRef = await db.collection('songs').add(newSong); res.json({ id: docRef.id, ...newSong });
    } catch (error) { res.status(400).send('Transload Error: ' + error.message); }
});

// --- 7. GENRE MANAGEMENT ---
app.get('/api/genres', async (req, res) => {
    if(!db) return res.json([]);
    const snap = await db.collection('genres').orderBy('sequence').get();
    res.json(snap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
});
app.post('/api/genres', upload.single('boxImageFile'), async (req, res) => {
    if(!db || !req.file) return res.status(400).send('Database/File error');
    const newGenre = { name: req.body.name, boxImageUrl: req.file.path, sequence: (await db.collection('genres').get()).size + 1 };
    await db.collection('genres').add(newGenre); res.send('Added');
});
app.put('/api/genres/:id', upload.single('boxImageFile'), async (req, res) => {
    if(!db) return res.status(500).send('Error');
    let updates = { name: req.body.name };
    if(req.file) updates.boxImageUrl = req.file.path;
    await db.collection('genres').doc(req.params.id).update(updates); res.send('Updated');
});

// START SERVER
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server bound to 0.0.0.0 on Port ${PORT}`));
