require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fileUpload = require('express-fileupload');
const path = require('path');
const cors = require('cors');
const admin = require('firebase-admin');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 80;

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(__dirname));

// Use express-fileupload for easier handling of multiple fields/files
app.use(fileUpload({
    useTempFiles: true,
    tempFileDir: '/tmp/'
}));

// --- 1. FIREBASE INITIALIZATION ---
let db;
if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    console.error("❌ FATAL ERROR: Missing FIREBASE_SERVICE_ACCOUNT_JSON!");
} else {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        console.log('✅ Google Firebase Connected!');
        db = admin.firestore();
    } catch (error) { console.error('❌ Firebase Connection Error:', error.message); }
}

// --- 2. CLOUDINARY INITIALIZATION ---
if (!process.env.CLOUDINARY_CLOUD_NAME) {
    console.error("❌ FATAL ERROR: Missing Cloudinary Variables!");
} else {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
    });
    console.log('✅ Cloudinary Connected!');
}

// Set up Storage for Multer (we only use Multer for MP3 upload now)
const multerStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: { folder: 'dj_music', resource_type: 'auto' }
});
const multerUpload = multer({ storage: multerStorage });

// --- HELPER: LOGGING SYSTEM ---
async function logEvent(type, message) {
    try { if(db) await db.collection('logs').add({ type, message, timestamp: new Date().toISOString() }); } catch(e) {}
}

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'music.html')); });

// --- 3. AUTH & USER API ---
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
        
        // Log Registration
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
    if (doc.exists) res.json(doc.data()); else res.status(404).send('User not found');
});

app.get('/api/all-users', async (req, res) => {
    if(!db) return res.json([]);
    try {
        const snapshot = await db.collection('users').get();
        res.json(snapshot.docs.map(doc => { const d = doc.data(); return { username: d.username, email: d.email, phone: d.phone, tokens: d.tokens || 0, purchases: d.purchases || [] }; }));
    } catch (e) { res.status(500).json([]); }
});

app.post('/api/users/:username/profile-pic', async (req, res) => {
    try {
        if(!db) return res.status(500).send('Database not connected');
        const userRef = db.collection('users').doc(req.params.username.toLowerCase());
        if (!(await userRef.get()).exists) return res.status(404).send('Not found');
        
        const result = await cloudinary.uploader.upload(req.body.imageBase64, { folder: 'dj_profiles' });
        await userRef.update({ profilePic: result.secure_url }); res.json({ profilePic: result.secure_url });
    } catch (e) { res.status(500).send('Upload Error: ' + e.message); }
});

app.put('/api/users/:username/change-username', async (req, res) => {
    try {
        if(!db) return res.status(500).send('Database not connected');
        const oldId = req.params.username.toLowerCase(); const newId = req.body.newUsername.toLowerCase();
        if ((await db.collection('users').doc(newId).get()).exists) return res.status(400).send('Username taken.');
        const oldRef = db.collection('users').doc(oldId); const doc = await oldRef.get(); if (!doc.exists) return res.status(404).send('Not found');
        const data = doc.data(); data.username = req.body.newUsername; 
        await db.collection('users').doc(newId).set(data); await oldRef.delete();
        res.json({ success: true, username: req.body.newUsername });
    } catch (e) { res.status(500).send('DB Error: ' + e.message); }
});

app.put('/api/users/:username/change-email', async (req, res) => { await db.collection('users').doc(req.params.username.toLowerCase()).update({ email: req.body.newEmail }); res.send('Updated'); });
app.put('/api/users/:username/change-phone', async (req, res) => { await db.collection('users').doc(req.params.username.toLowerCase()).update({ phone: req.body.newPhone }); res.send('Updated'); });

app.put('/api/users/:username/set-tokens', async (req, res) => { 
    await db.collection('users').doc(req.params.username.toLowerCase()).update({ tokens: parseInt(req.body.tokens) || 0 }); 
    await logEvent('admin', `Modified token balance for <span style="font-weight:600;">${req.params.username}</span> to ${req.body.tokens}`);
    res.send('Updated'); 
});

app.delete('/api/users/:username', async (req, res) => { 
    await db.collection('users').doc(req.params.username.toLowerCase()).delete(); 
    await logEvent('admin', `Deleted user account: <span style="font-weight:600; color:var(--danger);">${req.params.username}</span>`);
    res.send('Deleted'); 
});

app.post('/api/users/:username/topup', async (req, res) => {
    if(!db) return res.status(500).send('Database not connected');
    const userRef = db.collection('users').doc(req.params.username.toLowerCase());
    const doc = await userRef.get(); if (!doc.exists) return res.status(404).send('User not found');
    const newTokens = (doc.data().tokens || 0) + req.body.amount;
    await userRef.update({ tokens: newTokens }); res.json({ tokens: newTokens });
});

app.post('/api/users/:username/purchase', async (req, res) => {
    try {
        if(!db) return res.status(500).send('Database not connected');
        // Search in the *published* collection
        const songDoc = await db.collection('publishedSongs').doc(req.body.songId).get(); if (!songDoc.exists) return res.status(404).send('Song not found');
        const song = songDoc.data();
        const userRef = db.collection('users').doc(req.params.username.toLowerCase());
        const userDoc = await userRef.get(); if (!userDoc.exists) return res.status(404).send('User not found');
        const user = userDoc.data();

        user.purchases = user.purchases || [];
        if (user.purchases.some(p => p.songId === req.body.songId)) return res.status(400).send('Already purchased');

        const price = song.price !== undefined ? song.price : 10;
        if (user.tokens >= price) {
            user.tokens -= price;
            const purchaseId = Math.random().toString(36).substr(2, 10).toUpperCase();
            user.purchases.push({ songId: req.body.songId, songName: song.title, filepath: song.filepath, tokensSpent: price, purchaseId, purchaseTime: new Date().toISOString() });
            await userRef.update({ tokens: user.tokens, purchases: user.purchases });
            res.json({ success: true, tokens: user.tokens, purchases: user.purchases });
        } else res.status(400).send('Insufficient tokens');
    } catch (e) { res.status(500).send('DB Error: ' + e.message); }
});

app.post('/api/forgot-password', async (req, res) => {
    if(!db) return res.status(500).send('Database not connected'); const { contact } = req.body; 
    let uQ = await db.collection('users').where('contact', '==', contact).get();
    if(uQ.empty) uQ = await db.collection('users').where('email', '==', contact).get();
    if(uQ.empty) uQ = await db.collection('users').where('phone', '==', contact).get();
    if (!uQ.empty) res.json({ success: true, resetToken: uQ.docs[0].id }); else res.status(400).send('Not found.');
});
app.post('/api/reset-password', async (req, res) => {
    const userRef = db.collection('users').doc(req.body.token); const doc = await userRef.get();
    if (doc.exists) { await userRef.update({ password: req.body.newPassword }); res.send('Password reset.'); } else res.status(400).send('Invalid token.');
});

// --- 4. LOGS API ---
app.get('/api/logs/:type', async (req, res) => {
    if(!db) return res.json([]);
    try {
        const snap = await db.collection('logs').where('type', '==', req.params.type).get();
        let logs = snap.docs.map(d => ({id: d.id, ...d.data()}));
        logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        res.json(logs);
    } catch(e) { res.json([]); }
});

app.post('/api/logs/delete', async (req, res) => {
    if(!db) return res.send('ok');
    const batch = db.batch(); req.body.ids.forEach(id => batch.delete(db.collection('logs').doc(id)));
    await batch.commit(); res.send('ok');
});

app.delete('/api/logs/:type/all', async (req, res) => {
    if(!db) return res.send('ok');
    const snap = await db.collection('logs').where('type', '==', req.params.type).get();
    const batch = db.batch(); snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit(); res.send('ok');
});

// --- 5. ADMIN / LIBRARY API (PENDING) ---
// Global settings
app.get('/api/settings', async (req, res) => {
    if(!db) return res.json({ headerTitle: 'musicscraper', description: 'Music Library Portal', bannerUrl: '' });
    const doc = await db.collection('settings').doc('global').get(); 
    res.json(doc.exists ? doc.data() : { headerTitle: 'musicscraper', description: 'Music Library Portal', bannerUrl: '' });
});
app.put('/api/settings', async (req, res) => { 
    if(!db) return res.status(500).send('DB not connected');
    await db.collection('settings').doc('global').set(req.body, { merge: true }); 
    res.send('Updated'); 
});

app.post('/api/upload-banner', async (req, res) => {
    if(!db || !req.files || !req.files.bannerFile) return res.status(400).send('Request failed');
    try {
        const result = await cloudinary.uploader.upload(req.files.bannerFile.tempFilePath, { folder: 'dj_assets' });
        await db.collection('settings').doc('global').set({ bannerUrl: result.secure_url }, { merge: true });
        res.json({ bannerUrl: result.secure_url });
    } catch(e) { res.status(500).send('Upload Error: ' + e.message); }
});

// Genres (Pending)
app.get('/api/genres/pending', async (req, res) => {
    if(!db) return res.json([]);
    try { const snap = await db.collection('pendingGenres').orderBy('name').get(); res.json(snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))); } catch(e) { res.status(500).json([]); }
});

app.post('/api/genres/pending', async (req, res) => {
    if(!db || !req.files || !req.files.genrePic) return res.status(400).send('Missing fields');
    try {
        const result = await cloudinary.uploader.upload(req.files.genrePic.tempFilePath, { folder: 'dj_genres' });
        const newGenre = { name: req.body.name, pictureUrl: result.secure_url, description: req.body.description || '' };
        const docRef = await db.collection('pendingGenres').add(newGenre);
        res.json({ id: docRef.id, ...newGenre });
    } catch(e) { res.status(500).send('Upload Error: ' + e.message); }
});

app.put('/api/genres/pending/:id', async (req, res) => {
    if(!db) return res.status(500).send('DB not connected');
    let updates = { name: req.body.name, description: req.body.description || '' };
    if(req.files && req.files.genrePic) {
        const result = await cloudinary.uploader.upload(req.files.genrePic.tempFilePath, { folder: 'dj_genres' });
        updates.pictureUrl = result.secure_url;
    }
    await db.collection('pendingGenres').doc(req.params.id).update(updates);
    res.send('Updated');
});

app.delete('/api/genres/pending/:id', async (req, res) => {
    if(!db) return res.status(500).send('DB not connected');
    await db.collection('pendingGenres').doc(req.params.id).delete();
    res.send('Deleted');
});

// Songs (Pending)
app.get('/api/songs/pending', async (req, res) => {
    if(!db) return res.json([]);
    try { const snap = await db.collection('pendingSongs').orderBy('sequence').get(); res.json(snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))); } catch(e) { res.status(500).json([]); }
});

app.post('/api/songs/pending', async (req, res) => {
    if(!db || !req.files || !req.files.mp3file || !req.files.coverArt || !req.body.name || !req.body.categoryIds) return res.status(400).send('Missing critical fields');
    try {
        // Upload MP3 to 'dj_music' folder (resource_type: "auto" is important)
        const mp3Result = await cloudinary.uploader.upload(req.files.mp3file.tempFilePath, { folder: 'dj_music', resource_type: "auto" });
        // Upload Cover Art to 'dj_covers' folder
        const coverResult = await cloudinary.uploader.upload(req.files.coverArt.tempFilePath, { folder: 'dj_covers' });
        
        const categoryIds = req.body.categoryIds.split(','); // Convert string from FormData to array

        const newSong = { 
            title: req.body.name,
            artist: req.body.artist || 'musicscraper',
            categoryIds: categoryIds, 
            filepath: mp3Result.secure_url, 
            coverUrl: coverResult.secure_url,
            size: req.files.mp3file.size, 
            uploadTime: new Date().toISOString(), 
            sequence: (await db.collection('pendingSongs').get()).size + 1, 
            price: parseInt(req.body.price) || 10 
        };
        const docRef = await db.collection('pendingSongs').add(newSong);
        res.json({ id: docRef.id, ...newSong });
    } catch (e) { res.status(500).send('Upload Error: ' + e.message); }
});

// Detailed Transload endpoint
app.post('/api/transload/pending', async (req, res) => {
    if(!db || !req.files || !req.files.coverArt || !req.body.name || !req.body.categoryIds || !req.body.mp3Url) return res.status(400).send('Missing fields');
    try {
        // Upload cover art
        const coverResult = await cloudinary.uploader.upload(req.files.coverArt.tempFilePath, { folder: 'dj_covers' });
        // Fetch mp3 to get size
        const response = await fetch(req.body.mp3Url);
        if(!response.ok) throw new Error("Could not fetch MP3 for sizing");
        const size = response.headers.get('content-length') || 0;

        const categoryIds = req.body.categoryIds.split(',');
        const newSong = {
            title: req.body.name,
            artist: req.body.artist || 'musicscraper',
            categoryIds: categoryIds,
            filepath: req.body.mp3Url, // Use direct URL
            coverUrl: coverResult.secure_url,
            size: parseInt(size),
            uploadTime: new Date().toISOString(),
            sequence: (await db.collection('pendingSongs').get()).size + 1,
            price: parseInt(req.body.price) || 10
        };
        const docRef = await db.collection('pendingSongs').add(newSong);
        res.json({ id: docRef.id, ...newSong });
    } catch(e) { res.status(500).send('Transload Error: ' + e.message); }
});

app.put('/api/songs/pending/:id', async (req, res) => {
    if(!db) return res.status(500).send('DB not connected');
    let updates = {
        title: req.body.name,
        artist: req.body.artist || 'musicscraper',
        price: parseInt(req.body.price) || 10,
        categoryIds: req.body.categoryIds ? req.body.categoryIds.split(',') : []
    };
    if(req.files && req.files.coverArt) {
        const result = await cloudinary.uploader.upload(req.files.coverArt.tempFilePath, { folder: 'dj_covers' });
        updates.coverUrl = result.secure_url;
    }
    await db.collection('pendingSongs').doc(req.params.id).update(updates);
    res.send('Updated');
});

app.put('/api/songs/pending/reorder', async (req, res) => {
    const batch = db.batch(); req.body.orderedIds.forEach((id, index) => { batch.update(db.collection('pendingSongs').doc(id), { sequence: index + 1 }); }); await batch.commit(); res.send('Reordered');
});
app.delete('/api/songs/pending/:id', async (req, res) => {
    await db.collection('pendingSongs').doc(req.params.id).delete();
    const snap = await db.collection('pendingSongs').orderBy('sequence').get(); const batch = db.batch(); snap.docs.forEach((d, i) => batch.update(d.ref, { sequence: i + 1 })); await batch.commit();
    res.send('Deleted');
});

// --- 6. PUBLISH ENDPOINT ---
app.post('/api/publish', async (req, res) => {
    if(!db) return res.status(500).send('DB not connected');
    try {
        logEvent('admin', 'Initiated data publish sequence.');
        // Clear old published data
        const pSongsSnap = await db.collection('publishedSongs').get();
        const pGenresSnap = await db.collection('publishedGenres').get();
        const batch = db.batch();
        pSongsSnap.docs.forEach(doc => batch.delete(doc.ref));
        pGenresSnap.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit(); // Perform deletion

        // Copy pending to final collections
        const newBatch = db.batch();
        const pendingSongs = await db.collection('pendingSongs').get();
        const pendingGenres = await db.collection('pendingGenres').get();
        
        pendingSongs.docs.forEach(doc => newBatch.set(db.collection('publishedSongs').doc(doc.id), doc.data()));
        pendingGenres.docs.forEach(doc => newBatch.set(db.collection('publishedGenres').doc(doc.id), doc.data()));
        
        await newBatch.commit();
        logEvent('admin', 'Published new genre and song list data successfully.');
        res.send('Publish successful!');
    } catch(e) { res.status(500).send('Publish failed: ' + e.message); }
});

// --- 7. PUBLIC API (PUBLISHED DATA) ---
// Fetch public genres (published)
app.get('/api/genres', async (req, res) => {
    if(!db) return res.json([]);
    try { const snap = await db.collection('publishedGenres').orderBy('name').get(); res.json(snap.docs.map(doc => ({ id: doc.id, ...doc.data() }))); } catch(e) { res.status(500).json([]); }
});

// Fetch public songs by genre ID (published)
app.get('/api/genres/:id/songs', async (req, res) => {
    if(!db) return res.json([]);
    try {
        const snap = await db.collection('publishedSongs').where('categoryIds', 'array-contains', req.params.id).get();
        let songs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        songs.sort((a,b) => a.sequence - b.sequence);
        res.json(songs);
    } catch(e) { res.status(500).json([]); }
});

// Fetch detailed song info by ID (published)
app.get('/api/songs/:id', async (req, res) => {
    if(!db) return res.status(500).send('DB not connected');
    try {
        const doc = await db.collection('publishedSongs').doc(req.params.id).get();
        if(doc.exists) res.json({id: doc.id, ...doc.data()});
        else res.status(404).send('Song not found');
    } catch(e) { res.status(500).send('DB Error: ' + e.message); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 musicscraper bound to 0.0.0.0 on Port ${PORT}`));
