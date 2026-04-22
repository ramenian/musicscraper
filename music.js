require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 80;

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(__dirname));

// --- 1. THE ULTIMATE FIREBASE INITIALIZATION ---
let db;
let bucket;

if (!process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || !process.env.FIREBASE_STORAGE_BUCKET) {
    console.error("❌ FATAL ERROR: Missing FIREBASE_SERVICE_ACCOUNT_BASE64 or FIREBASE_STORAGE_BUCKET!");
} else {
    try {
        // Decode the Base64 string back into a perfect JSON object
        const serviceAccountBuffer = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64');
        const serviceAccount = JSON.parse(serviceAccountBuffer.toString('utf-8'));

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            storageBucket: process.env.FIREBASE_STORAGE_BUCKET
        });
        console.log('✅ Google Firebase Connected successfully!');
        
        db = admin.firestore();
        bucket = admin.storage().bucket();
    } catch (error) {
        console.error('❌ Firebase Connection Error:', error.message);
    }
}

// --- FILE STORAGE (Google Cloud Memory Buffer) ---
const upload = multer({ 
    storage: multer.memoryStorage(),
    fileFilter: (req, file, cb) => {
        const isAudio = file.mimetype.includes('audio') || file.originalname.endsWith('.mp3') || file.originalname.endsWith('.m4a');
        const isImage = file.mimetype.includes('image');
        if (isAudio || isImage) cb(null, true); else cb(new Error('Invalid file type.'));
    }
});

async function uploadToFirebase(buffer, originalName, mimetype, folder) {
    if(!bucket) throw new Error("Firebase Bucket not initialized");
    const filename = `${folder}/${Date.now()}-${originalName.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const file = bucket.file(filename);
    await file.save(buffer, { contentType: mimetype });
    await file.makePublic(); 
    return {
        url: `https://storage.googleapis.com/${bucket.name}/${filename}`,
        storagePath: filename
    };
}

// --- 2. ROUTES (RENDER HEALTH CHECK FIX) ---
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'music.html')));

// --- 3. AUTH & USER API (FIRESTORE) ---
app.post('/api/register', async (req, res) => {
    try {
        if(!db) return res.status(500).send('Database not connected');
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
    } catch (e) { res.status(500).send('Server error'); }
});

app.post('/api/login', async (req, res) => {
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
});

app.get('/api/users/:username', async (req, res) => {
    if(!db) return res.status(500).send('Database not connected');
    const doc = await db.collection('users').doc(req.params.username.toLowerCase()).get();
    if (doc.exists) res.json(doc.data()); else res.status(404).send('Not found');
});

app.get('/api/all-users', async (req, res) => {
    if(!db) return res.json([]);
    const snapshot = await db.collection('users').get();
    const users = snapshot.docs.map(doc => {
        const data = doc.data();
        return { username: data.username, email: data.email, phone: data.phone, tokens: data.tokens || 0 };
    });
    res.json(users);
});

app.post('/api/users/:username/profile-pic', async (req, res) => {
    try {
        if(!db) return res.status(500).send('Database not connected');
        const userRef = db.collection('users').doc(req.params.username.toLowerCase());
        const doc = await userRef.get();
        if (!doc.exists) return res.status(404).send('Not found');

        const base64Data = req.body.imageBase64.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');
        
        const uploadResult = await uploadToFirebase(buffer, 'profile.png', 'image/png', 'dj_profiles');
        
        await userRef.update({ profilePic: uploadResult.url });
        res.json({ profilePic: uploadResult.url });
    } catch (e) { res.status(500).send('Upload failed'); }
});

app.put('/api/users/:username/change-username', async (req, res) => {
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
});

app.put('/api/users/:username/change-email', async (req, res) => {
    if(!db) return res.status(500).send('Database not connected');
    await db.collection('users').doc(req.params.username.toLowerCase()).update({ email: req.body.newEmail }); res.send('Updated');
});
app.put('/api/users/:username/change-phone', async (req, res) => {
    if(!db) return res.status(500).send('Database not connected');
    await db.collection('users').doc(req.params.username.toLowerCase()).update({ phone: req.body.newPhone }); res.send('Updated');
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
        user.purchases.push({ songId: songId, songName: song.filename, filepath: song.filepath, tokensSpent: price });
        await userRef.update({ tokens: user.tokens, purchases: user.purchases });
        res.json({ success: true, tokens: user.tokens, purchases: user.purchases });
    } else res.status(400).send('Insufficient tokens');
});

app.post('/api/forgot-password', async (req, res) => {
    if(!db) return res.status(500).send('Database not connected');
    const { contact } = req.body; 
    let userQuery = await db.collection('users').where('contact', '==', contact).get();
    if(userQuery.empty) userQuery = await db.collection('users').where('email', '==', contact).get();
    if(userQuery.empty) userQuery = await db.collection('users').where('phone', '==', contact).get();
    
    if (!userQuery.empty) res.json({ success: true, resetToken: userQuery.docs[0].id }); 
    else res.status(400).send('Not found.');
});
app.post('/api/reset-password', async (req, res) => {
    if(!db) return res.status(500).send('Database not connected');
    const userRef = db.collection('users').doc(req.body.token);
    const doc = await userRef.get();
    if (doc.exists) { await userRef.update({ password: req.body.newPassword }); res.send('Password reset.'); } 
    else res.status(400).send('Invalid token.');
});

// --- 4. ADMIN / LIBRARY API (FIRESTORE) ---
app.get('/api/settings', async (req, res) => {
    if(!db) return res.json({ headerTitle: 'DJ Music Library', bannerUrl: '' });
    const doc = await db.collection('settings').doc('global').get();
    res.json(doc.exists ? doc.data() : { headerTitle: 'DJ Music Library', bannerUrl: '' });
});

app.put('/api/settings', async (req, res) => {
    if(!db) return res.status(500).send('Database not connected');
    await db.collection('settings').doc('global').set({ headerTitle: req.body.headerTitle }, { merge: true });
    res.send('Updated');
});

app.post('/api/upload-banner', upload.single('bannerFile'), async (req, res) => {
    if(!db) return res.status(500).send('Database not connected');
    if (!req.file) return res.status(400).send('No file.');
    const result = await uploadToFirebase(req.file.buffer, req.file.originalname, req.file.mimetype, 'dj_assets');
    await db.collection('settings').doc('global').set({ bannerUrl: result.url }, { merge: true });
    const doc = await db.collection('settings').doc('global').get();
    res.json(doc.data());
});

app.get('/api/songs', async (req, res) => {
    if(!db) return res.json([]);
    const snapshot = await db.collection('songs').orderBy('sequence').get();
    const songs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(songs);
});

app.post('/api/upload', upload.single('mp3file'), async (req, res) => {
    if(!db) return res.status(500).send('Database not connected');
    if (!req.file) return res.status(400).send('No file.');
    try {
        const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
        const uploadResult = await uploadToFirebase(req.file.buffer, originalName, req.file.mimetype, 'dj_music');
        const snapshot = await db.collection('songs').get();
        const newSong = {
            filename: originalName, filepath: uploadResult.url, storagePath: uploadResult.storagePath,
            size: req.file.size, uploadTime: new Date().toISOString(), sequence: snapshot.size + 1, price: 10
        };
        const docRef = await db.collection('songs').add(newSong);
        res.json({ id: docRef.id, ...newSong });
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/transload', async (req, res) => {
    if(!db) return res.status(500).send('Database not connected');
    const { url } = req.body; 
    if (!url || url.toLowerCase().includes('.html') || !url.toLowerCase().split('?')[0].endsWith('.m4a')) return res.status(400).send('Only .m4a URLs allowed.');
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP Error`);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const uploadResult = await uploadToFirebase(buffer, 'TransloadedTrack.m4a', 'audio/m4a', 'dj_music');
        
        const snapshot = await db.collection('songs').get();
        const newSong = {
            filename: 'New Transloaded Track.m4a', filepath: uploadResult.url, storagePath: uploadResult.storagePath,
            size: buffer.byteLength, uploadTime: new Date().toISOString(), sequence: snapshot.size + 1, price: 10
        };
        const docRef = await db.collection('songs').add(newSong);
        res.json({ id: docRef.id, ...newSong });
    } catch (error) { res.status(400).send('Transload failed.'); }
});

app.put('/api/songs/:id/settings', async (req, res) => {
    if(!db) return res.status(500).send('Database not connected');
    const songRef = db.collection('songs').doc(req.params.id);
    const doc = await songRef.get();
    if (!doc.exists) return res.status(404).send('Not found');
    
    let updates = {};
    if (req.body.newName) { 
        let n = req.body.newName; const ext = doc.data().filename.includes('.m4a') ? '.m4a' : '.mp3'; 
        if (!n.toLowerCase().endsWith(ext)) n += ext; updates.filename = n; 
    }
    if (req.body.newPrice !== undefined) updates.price = parseInt(req.body.newPrice) || 0;
    
    await songRef.update(updates);
    res.send('Updated');
});

app.put('/api/songs/reorder', async (req, res) => {
    if(!db) return res.status(500).send('Database not connected');
    const batch = db.batch();
    req.body.orderedIds.forEach((id, index) => {
        const ref = db.collection('songs').doc(id);
        batch.update(ref, { sequence: index + 1 });
    });
    await batch.commit();
    res.send('Reordered');
});

app.delete('/api/songs/:id', async (req, res) => {
    if(!db) return res.status(500).send('Database not connected');
    const songRef = db.collection('songs').doc(req.params.id);
    const doc = await songRef.get();
    if (!doc.exists) return res.status(404).send('Not found');

    if (doc.data().storagePath) {
        try { await bucket.file(doc.data().storagePath).delete(); } catch(e) { console.log('File already missing in bucket'); }
    }

    await songRef.delete();
    const snapshot = await db.collection('songs').orderBy('sequence').get();
    const batch = db.batch();
    snapshot.docs.forEach((d, i) => batch.update(d.ref, { sequence: i + 1 }));
    await batch.commit();

    res.send('Deleted');
});

// START SERVER
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server successfully bound to 0.0.0.0 on Port ${PORT}`);
});
