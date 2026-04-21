const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const admin = require('firebase-admin');

// --- 1. FIREBASE INITIALIZATION ---
if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_PRIVATE_KEY) {
    console.error("❌ FATAL ERROR: Missing Firebase Environment Variables in Render.");
} else {
    try {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                // Replace literal \n with actual newlines for Render to read the key properly
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            }),
            storageBucket: process.env.FIREBASE_STORAGE_BUCKET
        });
        console.log('✅ Firebase Connected Successfully');
    } catch (error) {
        console.error('❌ Firebase Connection Error:', error);
    }
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

const app = express();
const PORT = process.env.PORT || 80;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// Multer using Memory Storage (files are held in RAM, then pushed to Google Storage)
const upload = multer({ 
    storage: multer.memoryStorage(),
    fileFilter: (req, file, cb) => {
        const isAudio = file.mimetype.includes('audio') || file.originalname.endsWith('.mp3') || file.originalname.endsWith('.m4a');
        const isImage = file.mimetype.includes('image');
        if (isAudio || isImage) cb(null, true); else cb(new Error('Invalid file type.'));
    }
});

// Helper: Upload Buffer to Firebase Storage and get Public URL
async function uploadToFirebase(buffer, filename, mimetype) {
    const file = bucket.file(`uploads/${Date.now()}-${filename}`);
    await file.save(buffer, { contentType: mimetype });
    // Generate the standard Firebase download URL
    return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(file.name)}?alt=media`;
}

// Helper: Get User Document Reference
async function getUserRef(username) {
    const snapshot = await db.collection('users').where('username', '==', username).get();
    if (snapshot.empty) return null;
    return snapshot.docs[0];
}

// --- 2. INITIALIZE SETTINGS ---
async function initSettings() {
    const doc = await db.collection('settings').doc('config').get();
    if (!doc.exists) await db.collection('settings').doc('config').set({ headerTitle: 'DJ Music Library', bannerUrl: '' });
}
initSettings();

// --- 3. ROUTES ---
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.redirect('/register.html'));

// --- 4. AUTH & USER API ---
app.post('/api/register', async (req, res) => {
    try {
        const { contact, username, password } = req.body;
        // Check if username or contact exists
        const userQuery = await db.collection('users').where('username', '==', username).get();
        const contactQuery = await db.collection('users').where('contact', '==', contact).get();
        
        if (!userQuery.empty || !contactQuery.empty) return res.status(400).send('USER HAS BEEN REGISTERED');
        
        const isEmail = contact.includes('@');
        const newUser = { 
            contact, username, password, 
            email: isEmail ? contact : '-', phone: isEmail ? '-' : contact,
            tokens: 0, purchases: [], profilePic: ''
        };
        await db.collection('users').add(newUser);
        res.json({ success: true, username: newUser.username });
    } catch (e) { res.status(500).send('Server error'); }
});

app.post('/api/login', async (req, res) => {
    const { contact, password } = req.body;
    let snapshot = await db.collection('users').where('contact', '==', contact).where('password', '==', password).get();
    if (snapshot.empty) snapshot = await db.collection('users').where('username', '==', contact).where('password', '==', password).get();
    
    if (!snapshot.empty) res.json({ success: true, username: snapshot.docs[0].data().username });
    else res.status(400).send('Invalid credentials.');
});

app.get('/api/users/:username', async (req, res) => {
    const userDoc = await getUserRef(req.params.username);
    if(userDoc) res.json(userDoc.data()); else res.status(404).send('Not found');
});

app.get('/api/all-users', async (req, res) => {
    const snapshot = await db.collection('users').get();
    const users = snapshot.docs.map(doc => {
        const d = doc.data();
        return { username: d.username, email: d.email || '-', phone: d.phone || '-', tokens: d.tokens || 0 };
    });
    res.json(users);
});

app.post('/api/users/:username/profile-pic', async (req, res) => {
    try {
        const userDoc = await getUserRef(req.params.username);
        if(!userDoc) return res.status(404).send('Not found');
        
        const base64Data = req.body.imageBase64.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');
        const url = await uploadToFirebase(buffer, 'profile.png', 'image/png');
        
        await userDoc.ref.update({ profilePic: url });
        res.json({ profilePic: url });
    } catch (e) { res.status(500).send('Upload failed'); }
});

// Edit Profile
app.put('/api/users/:username/change-username', async (req, res) => {
    const existing = await getUserRef(req.body.newUsername);
    if (existing) return res.status(400).send('Username taken.');
    
    const userDoc = await getUserRef(req.params.username);
    if(userDoc) {
        await userDoc.ref.update({ username: req.body.newUsername });
        res.json({ success: true, username: req.body.newUsername });
    } else res.status(404).send('Not found');
});
app.put('/api/users/:username/change-email', async (req, res) => {
    const userDoc = await getUserRef(req.params.username);
    if(userDoc) { await userDoc.ref.update({ email: req.body.newEmail }); res.send('Updated'); } else res.status(404).send('Not found');
});
app.put('/api/users/:username/change-phone', async (req, res) => {
    const userDoc = await getUserRef(req.params.username);
    if(userDoc) { await userDoc.ref.update({ phone: req.body.newPhone }); res.send('Updated'); } else res.status(404).send('Not found');
});
app.delete('/api/users/:username', async (req, res) => {
    const userDoc = await getUserRef(req.params.username);
    if(userDoc) { await userDoc.ref.delete(); res.send('Deleted'); } else res.status(404).send('Not found');
});

// Economy
app.post('/api/users/:username/topup', async (req, res) => {
    const userDoc = await getUserRef(req.params.username);
    if(!userDoc) return res.status(404).send('Not found');
    const newTokens = (userDoc.data().tokens || 0) + req.body.amount;
    await userDoc.ref.update({ tokens: newTokens });
    res.json({ tokens: newTokens });
});

app.post('/api/users/:username/purchase', async (req, res) => {
    const songDoc = await db.collection('songs').doc(req.body.songId).get();
    if (!songDoc.exists) return res.status(404).send('Song not found');
    const song = songDoc.data();
    
    const userDoc = await getUserRef(req.params.username);
    if(!userDoc) return res.status(404).send('User not found');
    const user = userDoc.data();
    
    const purchases = user.purchases || [];
    if(purchases.find(p => p.songId === songDoc.id)) return res.status(400).send('Already purchased');
    
    const price = song.price !== undefined ? song.price : 10;
    if((user.tokens || 0) >= price) {
        const newTokens = user.tokens - price;
        purchases.push({ songId: songDoc.id, songName: song.filename, filepath: song.filepath, tokensSpent: price });
        await userDoc.ref.update({ tokens: newTokens, purchases: purchases });
        res.json({ success: true, tokens: newTokens, purchases: purchases });
    } else res.status(400).send('Insufficient tokens');
});

// Passwords reset
app.post('/api/forgot-password', async (req, res) => {
    const { contact } = req.body; 
    let snapshot = await db.collection('users').where('contact', '==', contact).get();
    if(snapshot.empty) snapshot = await db.collection('users').where('email', '==', contact).get();
    if(snapshot.empty) snapshot = await db.collection('users').where('phone', '==', contact).get();
    
    if (!snapshot.empty) res.json({ success: true, resetToken: snapshot.docs[0].id }); 
    else res.status(400).send('Not found.');
});
app.post('/api/reset-password', async (req, res) => {
    const userRef = db.collection('users').doc(req.body.token);
    const doc = await userRef.get();
    if (doc.exists) { await userRef.update({ password: req.body.newPassword }); res.send('Password reset.'); } 
    else res.status(400).send('Invalid token.');
});

// --- 5. ADMIN / LIBRARY API ---
app.get('/api/settings', async (req, res) => {
    const doc = await db.collection('settings').doc('config').get();
    res.json(doc.exists ? doc.data() : { headerTitle: 'DJ Music', bannerUrl: '' });
});
app.put('/api/settings', async (req, res) => { 
    await db.collection('settings').doc('config').update({ headerTitle: req.body.headerTitle }); 
    res.send('Updated'); 
});
app.post('/api/upload-banner', upload.single('bannerFile'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file.');
    const url = await uploadToFirebase(req.file.buffer, req.file.originalname, req.file.mimetype);
    await db.collection('settings').doc('config').update({ bannerUrl: url });
    res.json({ bannerUrl: url });
});

app.get('/api/songs', async (req, res) => { 
    const snapshot = await db.collection('songs').orderBy('sequence').get();
    const songs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(songs);
});

app.post('/api/upload', upload.single('mp3file'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file.');
    const url = await uploadToFirebase(req.file.buffer, req.file.originalname, req.file.mimetype);
    const snapshot = await db.collection('songs').get();
    
    const newSongRef = db.collection('songs').doc();
    const songData = {
        id: newSongRef.id,
        filename: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
        filepath: url,
        size: req.file.size, uploadTime: new Date().toISOString(),
        sequence: snapshot.size + 1, price: 10
    };
    await newSongRef.set(songData);
    res.json(songData);
});

app.post('/api/transload', async (req, res) => {
    const { url } = req.body; 
    if (!url || url.toLowerCase().includes('.html') || !url.toLowerCase().split('?')[0].endsWith('.m4a')) return res.status(400).send('Only .m4a URLs allowed.');
    try {
        const response = await fetch(url); if (!response.ok) throw new Error(`HTTP Error`);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const firebaseURL = await uploadToFirebase(buffer, 'transload.m4a', 'audio/mp4');
        
        const snapshot = await db.collection('songs').get();
        const newSongRef = db.collection('songs').doc();
        const songData = {
            id: newSongRef.id, filename: 'New Transloaded Track.m4a',
            filepath: firebaseURL, size: buffer.byteLength, uploadTime: new Date().toISOString(),
            sequence: snapshot.size + 1, price: 10
        };
        await newSongRef.set(songData);
        res.json(songData);
    } catch (error) { res.status(400).send('Transload failed.'); }
});

app.put('/api/songs/:id/settings', async (req, res) => {
    const songRef = db.collection('songs').doc(req.params.id);
    const doc = await songRef.get();
    if (doc.exists) { 
        const updates = {};
        if (req.body.newName) { 
            let n = req.body.newName; const ext = doc.data().filename.includes('.m4a') ? '.m4a' : '.mp3'; 
            if (!n.toLowerCase().endsWith(ext)) n += ext; updates.filename = n; 
        }
        if (req.body.newPrice !== undefined) updates.price = parseInt(req.body.newPrice) || 0;
        await songRef.update(updates); res.send('Updated'); 
    } else res.status(404).send('Not found');
});

app.put('/api/songs/reorder', async (req, res) => {
    const batch = db.batch();
    req.body.orderedIds.forEach((id, index) => {
        const ref = db.collection('songs').doc(id);
        batch.update(ref, { sequence: index + 1 });
    });
    await batch.commit(); res.send('Reordered');
});

app.delete('/api/songs/:id', async (req, res) => {
    await db.collection('songs').doc(req.params.id).delete(); 
    // Re-sequence
    const snapshot = await db.collection('songs').orderBy('sequence').get();
    const batch = db.batch();
    snapshot.docs.forEach((doc, index) => batch.update(doc.ref, { sequence: index + 1 }));
    await batch.commit();
    res.send('Deleted');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server successfully bound to 0.0.0.0 on Port ${PORT}`);
});
