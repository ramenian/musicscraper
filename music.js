require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const admin = require('firebase-admin');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const crypto = require('crypto'); // Built-in Node module for security tokens

const app = express();
const PORT = process.env.PORT || 80;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname));

let db, bucket;
if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    console.error("❌ FATAL ERROR: Missing FIREBASE_SERVICE_ACCOUNT_JSON!");
} else {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount), storageBucket: process.env.FIREBASE_STORAGE_BUCKET });
        console.log('✅ Google Firebase Connected!');
        db = admin.firestore(); bucket = admin.storage().bucket();
    } catch (error) { console.error('❌ Firebase Error:', error.message); }
}

if (process.env.CLOUDINARY_CLOUD_NAME) {
    cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
}

const upload = multer({ 
    storage: multer.memoryStorage(),
    fileFilter: (req, file, cb) => {
        if(file.mimetype.includes('audio') || file.mimetype.includes('image') || file.originalname.match(/\.(mp3|m4a|jpg|jpeg|png)$/i)) cb(null, true); 
        else cb(new Error('Invalid file type.'));
    }
});

async function uploadToCloudinaryBase64(base64Str, folder) {
    if(!base64Str) return '';
    const result = await cloudinary.uploader.upload(base64Str, { folder: folder, resource_type: "auto" });
    return result.secure_url;
}

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'music.html')); });

async function logEvent(type, message) { try { if(db) await db.collection('logs').add({ type, message, timestamp: new Date().toISOString() }); } catch(e) {} }

// --- AUTH & USERS ---
app.post('/api/register', async (req, res) => {
    try {
        if(!db) return res.status(500).send('DB disconnected');
        const { contact, username, password } = req.body;
        const userRef = db.collection('users').doc(username.toLowerCase());
        if ((await userRef.get()).exists) return res.status(400).send('USER HAS BEEN REGISTERED');
        if (!(await db.collection('users').where('contact', '==', contact).get()).empty) return res.status(400).send('USER HAS BEEN REGISTERED');
        const isEmail = contact.includes('@');
        await userRef.set({ username, contact, password, email: isEmail ? contact : '-', phone: isEmail ? '-' : contact, tokens: 0, profilePic: '', purchases: [], createdAt: new Date().toISOString() });
        await logEvent('register', `<span style="color:#34c759; font-weight:600;">${username}</span> registered with ${contact}`);
        res.json({ success: true, username });
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/login', async (req, res) => {
    try {
        const { contact, password } = req.body;
        let uDoc = await db.collection('users').doc(contact.toLowerCase()).get();
        if (!uDoc.exists) { const q = await db.collection('users').where('contact', '==', contact).get(); if(!q.empty) uDoc = q.docs[0]; }
        if (uDoc && uDoc.data()?.password === password) res.json({ success: true, username: uDoc.data().username }); else res.status(400).send('Invalid credentials.');
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/api/users/:username', async (req, res) => {
    const doc = await db.collection('users').doc(req.params.username.toLowerCase()).get();
    if (doc.exists) res.json(doc.data()); else res.status(404).send('User not found');
});

app.get('/api/all-users', async (req, res) => { try { res.json((await db.collection('users').get()).docs.map(d => d.data())); } catch (e) { res.status(500).json([]); }});

app.post('/api/users/:username/profile-pic', async (req, res) => {
    try {
        const url = await uploadToCloudinaryBase64(req.body.imageBase64, 'dj_profiles');
        await db.collection('users').doc(req.params.username.toLowerCase()).update({ profilePic: url }); res.json({ profilePic: url });
    } catch (e) { res.status(500).send(e.message); }
});

app.put('/api/users/:username/change-username', async (req, res) => {
    try {
        const oldId = req.params.username.toLowerCase(), newId = req.body.newUsername.toLowerCase();
        if ((await db.collection('users').doc(newId).get()).exists) return res.status(400).send('Username taken.');
        const oldRef = db.collection('users').doc(oldId); const doc = await oldRef.get();
        const data = doc.data(); data.username = req.body.newUsername; 
        await db.collection('users').doc(newId).set(data); await oldRef.delete();
        res.json({ success: true, username: req.body.newUsername });
    } catch (e) { res.status(500).send(e.message); }
});

app.put('/api/users/:username/change-email', async (req, res) => { await db.collection('users').doc(req.params.username.toLowerCase()).update({ email: req.body.newEmail }); res.send('Updated'); });
app.put('/api/users/:username/change-phone', async (req, res) => { await db.collection('users').doc(req.params.username.toLowerCase()).update({ phone: req.body.newPhone }); res.send('Updated'); });
app.put('/api/users/:username/set-tokens', async (req, res) => { await db.collection('users').doc(req.params.username.toLowerCase()).update({ tokens: parseInt(req.body.tokens) || 0 }); await logEvent('admin', `Modified token balance for <span style="font-weight:600;">${req.params.username}</span> to ${req.body.tokens}`); res.send('Updated'); });
app.delete('/api/users/:username', async (req, res) => { await db.collection('users').doc(req.params.username.toLowerCase()).delete(); await logEvent('admin', `Deleted user account: <span style="font-weight:600; color:var(--danger);">${req.params.username}</span>`); res.send('Deleted'); });
app.post('/api/users/:username/topup', async (req, res) => {
    const userRef = db.collection('users').doc(req.params.username.toLowerCase()); const doc = await userRef.get();
    const newTokens = (doc.data().tokens || 0) + req.body.amount; await userRef.update({ tokens: newTokens }); res.json({ tokens: newTokens });
});

app.post('/api/users/:username/purchase', async (req, res) => {
    try {
        const songDoc = await db.collection('songs').doc(req.body.songId).get(); if (!songDoc.exists) return res.status(404).send('Song not found');
        const song = songDoc.data();
        const userRef = db.collection('users').doc(req.params.username.toLowerCase()); const userDoc = await userRef.get();
        const user = userDoc.data(); user.purchases = user.purchases || [];
        if (user.purchases.find(p => p.songId === req.body.songId)) return res.status(400).send('Already purchased');

        const price = song.price !== undefined ? song.price : 10;
        if (user.tokens >= price) {
            user.tokens -= price;
            const purchaseId = Math.random().toString(36).substr(2, 10).toUpperCase();
            user.purchases.push({ songId: req.body.songId, songName: song.filename, filepath: song.filepath, coverUrl: song.coverUrl, tokensSpent: price, purchaseId, purchaseTime: new Date().toISOString() });
            await userRef.update({ tokens: user.tokens, purchases: user.purchases });
            res.json({ success: true, tokens: user.tokens, purchases: user.purchases });
        } else res.status(400).send('Insufficient tokens');
    } catch (e) { res.status(500).send(e.message); }
});

// --- GENRES ---
app.get('/api/genres', async (req, res) => {
    try { res.json((await db.collection('genres').orderBy('sequence').get()).docs.map(d => ({ id: d.id, ...d.data() }))); } catch(e) { res.status(500).json([]); }
});
app.post('/api/genres', async (req, res) => {
    try {
        let coverUrl = req.body.coverBase64 ? await uploadToCloudinaryBase64(req.body.coverBase64, 'dj_genres') : '';
        const newGenre = { name: req.body.name, coverUrl, sequence: (await db.collection('genres').get()).size + 1 };
        const docRef = await db.collection('genres').add(newGenre); res.json({ id: docRef.id, ...newGenre });
    } catch(e) { res.status(500).send(e.message); }
});
app.put('/api/genres/:id', async (req, res) => {
    try {
        let updates = { name: req.body.name };
        if(req.body.coverBase64) updates.coverUrl = await uploadToCloudinaryBase64(req.body.coverBase64, 'dj_genres');
        await db.collection('genres').doc(req.params.id).update(updates); res.send('Updated');
    } catch(e) { res.status(500).send(e.message); }
});
app.put('/api/genres/reorder', async (req, res) => {
    try {
        const batch = db.batch(); req.body.orderedIds.forEach((id, index) => { batch.update(db.collection('genres').doc(id), { sequence: index + 1 }); }); await batch.commit(); res.send('Reordered');
    } catch(e) { res.status(500).send(e.message); }
});
app.delete('/api/genres/:id', async (req, res) => { await db.collection('genres').doc(req.params.id).delete(); res.send('Deleted'); });


// --- NEW SECURITY: PROXY STREAMING ROUTE ---
// 1. Generate a temporary play token
app.post('/api/play-token', (req, res) => {
    const { songId } = req.body;
    if (!songId) return res.status(400).send("No song ID");
    
    // Create a secure hash using the songId, the current minute, and a secret salt
    const secretSalt = process.env.FIREBASE_PROJECT_ID || "dj_secret_salt";
    const timeBlock = Math.floor(Date.now() / 60000); // Changes every minute
    
    const token = crypto.createHash('sha256').update(songId + timeBlock + secretSalt).digest('hex').substring(0, 16);
    
    // Send back the custom proxy URL
    res.json({ proxyUrl: `/play/${songId}?t=${token}` });
});

// 2. The secure stream route
app.get('/play/:songId', async (req, res) => {
    try {
        const { songId } = req.params;
        const { t } = req.query; // The token
        
        // Validate Token
        const secretSalt = process.env.FIREBASE_PROJECT_ID || "dj_secret_salt";
        const timeBlock = Math.floor(Date.now() / 60000);
        
        // Allow tokens from the current minute OR the previous minute (to handle edge-case timing delays)
        const validToken1 = crypto.createHash('sha256').update(songId + timeBlock + secretSalt).digest('hex').substring(0, 16);
        const validToken2 = crypto.createHash('sha256').update(songId + (timeBlock - 1) + secretSalt).digest('hex').substring(0, 16);

        if (t !== validToken1 && t !== validToken2) {
            // Block direct downloads!
            return res.status(403).send('403 Forbidden: Invalid or Expired Stream Token.');
        }

        // Fetch song from database to get the real Cloudinary/Firebase URL
        const songDoc = await db.collection('songs').doc(songId).get();
        if (!songDoc.exists) return res.status(404).send('Song not found');
        
        const realUrl = songDoc.data().filepath;

        // Proxy the stream to hide the real URL
        const fetch = require('node-fetch'); // Native fetch in Node 18+
        const response = await fetch(realUrl);
        
        if (!response.ok) throw new Error("Failed to fetch audio stream");

        // Forward headers (content-type, length, etc.) so the audio player works properly
        res.setHeader('Content-Type', response.headers.get('content-type') || 'audio/mpeg');
        res.setHeader('Accept-Ranges', 'bytes');
        if(response.headers.get('content-length')) {
            res.setHeader('Content-Length', response.headers.get('content-length'));
        }

        // Stream data to client
        response.body.pipe(res);

    } catch (e) {
        console.error("Stream Proxy Error:", e);
        res.status(500).send("Error streaming media.");
    }
});


// --- SONGS ---
app.get('/api/songs', async (req, res) => {
    try { res.json((await db.collection('songs').orderBy('sequence').get()).docs.map(doc => ({ id: doc.id, ...doc.data() }))); } catch(e) { res.status(500).json([]); }
});

async function saveSongData(fileBuffer, originalName, reqBody) {
    const filename = `dj_music/${Date.now()}-${originalName.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const file = bucket.file(filename);
    await file.save(fileBuffer, { contentType: 'audio/mpeg' });
    const [url] = await file.getSignedUrl({ action: 'read', expires: '01-01-2100' });
    
    let coverUrl = '';
    if(reqBody.coverBase64) coverUrl = await uploadToCloudinaryBase64(reqBody.coverBase64, 'dj_covers');

    const snapshot = await db.collection('songs').get();
    const newSong = {
        filename: reqBody.title || originalName, filepath: url, storagePath: filename,
        coverUrl: coverUrl, genreId: reqBody.genreId || 'none',
        size: fileBuffer.length, uploadTime: new Date().toISOString(), sequence: snapshot.size + 1, price: parseInt(reqBody.price) || 10
    };
    const docRef = await db.collection('songs').add(newSong); return { id: docRef.id, ...newSong };
}

app.post('/api/upload', upload.single('mp3file'), async (req, res) => {
    try { if (!req.file) return res.status(400).send('No file.'); res.json(await saveSongData(req.file.buffer, req.file.originalname, req.body)); } 
    catch (e) { res.status(500).send(e.message); }
});

app.post('/api/transload', async (req, res) => {
    try {
        const response = await fetch(req.body.url); if (!response.ok) throw new Error(`HTTP Error from source URL`);
        const buffer = Buffer.from(await response.arrayBuffer());
        res.json(await saveSongData(buffer, 'TransloadedTrack.m4a', req.body));
    } catch (e) { res.status(400).send(e.message); }
});

app.put('/api/songs/:id/settings', async (req, res) => {
    let updates = {};
    if (req.body.newName) updates.filename = req.body.newName;
    if (req.body.newPrice !== undefined) updates.price = parseInt(req.body.newPrice) || 0;
    await db.collection('songs').doc(req.params.id).update(updates); res.send('Updated');
});
app.put('/api/songs/reorder', async (req, res) => {
    const batch = db.batch(); req.body.orderedIds.forEach((id, index) => { batch.update(db.collection('songs').doc(id), { sequence: index + 1 }); }); await batch.commit(); res.send('Reordered');
});
app.delete('/api/songs/:id', async (req, res) => { await db.collection('songs').doc(req.params.id).delete(); res.send('Deleted'); });

// --- SETTINGS & LOGS ---
app.get('/api/settings', async (req, res) => {
    if(!db) return res.json({ headerTitle: 'MusicScraper', heroTitle: '专属DJ节奏空间', bannerUrl: '' });
    const doc = await db.collection('settings').doc('global').get(); res.json(doc.exists ? doc.data() : { headerTitle: 'MusicScraper', heroTitle: '专属DJ节奏空间', bannerUrl: '' });
});
app.put('/api/settings', async (req, res) => { await db.collection('settings').doc('global').set({ headerTitle: req.body.headerTitle, heroTitle: req.body.heroTitle }, { merge: true }); res.send('Updated'); });

app.get('/api/logs/:type', async (req, res) => {
    try { const snap = await db.collection('logs').where('type', '==', req.params.type).get(); res.json(snap.docs.map(d => ({id: d.id, ...d.data()})).sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp))); } catch(e) { res.json([]); }
});
app.post('/api/logs/delete', async (req, res) => { const batch = db.batch(); req.body.ids.forEach(id => batch.delete(db.collection('logs').doc(id))); await batch.commit(); res.send('ok'); });
app.delete('/api/logs/:type/all', async (req, res) => { const batch = db.batch(); (await db.collection('logs').where('type', '==', req.params.type).get()).docs.forEach(d => batch.delete(d.ref)); await batch.commit(); res.send('ok'); });

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server bound to 0.0.0.0 on Port ${PORT}`));
