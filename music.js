const express = require('express');
const multer = require('multer');
const cors = require('cors');
const admin = require('firebase-admin');

// --- 1. FIREBASE INITIALIZATION ---
if (!process.env.FIREBASE_PROJECT_ID) {
    console.error("❌ FATAL ERROR: Missing Firebase Environment Variables.");
}

admin.initializeApp({
    credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        // Render environment variables escape newlines, so we must un-escape them
        privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
    }),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

const app = express();
const PORT = process.env.PORT || 80;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// Use Memory Storage so files go straight to Google, avoiding Render's local disk
const upload = multer({ storage: multer.memoryStorage() });

// Helper to upload a buffer to Firebase Storage and get a public URL
async function uploadToFirebase(buffer, originalName, folder, mimetype) {
    const fileName = `${folder}/${Date.now()}-${originalName.replace(/[^a-zA-Z0-9.\-_]/g, '')}`;
    const fileUpload = bucket.file(fileName);
    await fileUpload.save(buffer, { contentType: mimetype });
    
    // Construct the public Firebase Storage URL
    return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(fileName)}?alt=media`;
}

// --- 2. ROUTES ---
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.redirect('/music.html'));

// --- 3. AUTH & USER API ---
app.post('/api/register', async (req, res) => {
    try {
        const { contact, username, password } = req.body;
        
        // Check if username exists (using it as the Document ID)
        const userRef = db.collection('users').doc(username.toLowerCase());
        const doc = await userRef.get();
        if (doc.exists) return res.status(400).send('USER HAS BEEN REGISTERED');

        // Check if contact exists
        const contactQuery = await db.collection('users').where('contact', '==', contact).get();
        if (!contactQuery.empty) return res.status(400).send('Contact already registered.');
        
        const isEmail = contact.includes('@');
        const userData = {
            username, password, contact, 
            email: isEmail ? contact : '-', 
            phone: isEmail ? '-' : contact,
            tokens: 0, purchases: [], profilePic: '', createdAt: new Date().toISOString()
        };
        
        await userRef.set(userData);
        res.json({ success: true, username });
    } catch (e) { res.status(500).send('Server error'); }
});

app.post('/api/login', async (req, res) => {
    const { contact, password } = req.body;
    try {
        let userDoc;
        // Try username first
        const userRef = db.collection('users').doc(contact.toLowerCase());
        const doc = await userRef.get();
        
        if (doc.exists && doc.data().password === password) {
            userDoc = doc.data();
        } else {
            // Try contact (email/phone)
            const query = await db.collection('users').where('contact', '==', contact).where('password', '==', password).get();
            if (!query.empty) userDoc = query.docs[0].data();
        }

        if (userDoc) res.json({ success: true, username: userDoc.username });
        else res.status(400).send('Invalid credentials.');
    } catch (e) { res.status(500).send('Server error'); }
});

app.get('/api/users/:username', async (req, res) => {
    const doc = await db.collection('users').doc(req.params.username.toLowerCase()).get();
    if(doc.exists) {
        const data = doc.data();
        res.json({ username: data.username, tokens: data.tokens || 0, purchases: data.purchases || [], profilePic: data.profilePic || '', email: data.email || '-', phone: data.phone || '-' });
    } else res.status(404).send('Not found');
});

app.get('/api/all-users', async (req, res) => {
    const snapshot = await db.collection('users').get();
    const users = [];
    snapshot.forEach(doc => {
        const data = doc.data();
        users.push({ username: data.username, email: data.email, phone: data.phone, tokens: data.tokens });
    });
    res.json(users);
});

app.post('/api/users/:username/profile-pic', async (req, res) => {
    try {
        const userRef = db.collection('users').doc(req.params.username.toLowerCase());
        const doc = await userRef.get();
        if(!doc.exists) return res.status(404).send('Not found');
        
        const base64Data = req.body.imageBase64.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');
        const url = await uploadToFirebase(buffer, 'profile.png', 'dj_profiles', 'image/png');
        
        await userRef.update({ profilePic: url });
        res.json({ profilePic: url });
    } catch (e) { res.status(500).send('Upload failed'); }
});

app.put('/api/users/:username/change-username', async (req, res) => {
    // Changing document ID in Firestore requires creating a new doc and deleting the old one
    const oldRef = db.collection('users').doc(req.params.username.toLowerCase());
    const newRef = db.collection('users').doc(req.body.newUsername.toLowerCase());
    
    const newDoc = await newRef.get();
    if(newDoc.exists) return res.status(400).send('Username taken.');
    
    const oldDoc = await oldRef.get();
    if(!oldDoc.exists) return res.status(404).send('User not found.');
    
    const data = oldDoc.data();
    data.username = req.body.newUsername;
    await newRef.set(data);
    await oldRef.delete();
    
    res.json({ success: true, username: req.body.newUsername });
});

app.put('/api/users/:username/change-email', async (req, res) => { await db.collection('users').doc(req.params.username.toLowerCase()).update({ email: req.body.newEmail }); res.send('Updated'); });
app.put('/api/users/:username/change-phone', async (req, res) => { await db.collection('users').doc(req.params.username.toLowerCase()).update({ phone: req.body.newPhone }); res.send('Updated'); });
app.delete('/api/users/:username', async (req, res) => { await db.collection('users').doc(req.params.username.toLowerCase()).delete(); res.send('Deleted'); });

// --- 4. ECONOMY ---
app.post('/api/users/:username/topup', async (req, res) => {
    const userRef = db.collection('users').doc(req.params.username.toLowerCase());
    const doc = await userRef.get();
    if(!doc.exists) return res.status(404).send('Not found');
    
    const newTokens = (doc.data().tokens || 0) + req.body.amount;
    await userRef.update({ tokens: newTokens });
    res.json({ tokens: newTokens });
});

app.post('/api/users/:username/purchase', async (req, res) => {
    const songDoc = await db.collection('songs').doc(req.body.songId).get();
    if (!songDoc.exists) return res.status(404).send('Song not found');
    const song = songDoc.data();

    const userRef = db.collection('users').doc(req.params.username.toLowerCase());
    const userDoc = await userRef.get();
    if(!userDoc.exists) return res.status(404).send('User not found');
    
    const userData = userDoc.data();
    userData.tokens = userData.tokens || 0;
    userData.purchases = userData.purchases || [];
    
    if(userData.purchases.find(p => p.songId === req.body.songId)) return res.status(400).send('Already purchased');
    
    const price = song.price !== undefined ? song.price : 10;
    if(userData.tokens >= price) {
        userData.tokens -= price;
        userData.purchases.push({ songId: req.body.songId, songName: song.filename, filepath: song.filepath, tokensSpent: price });
        await userRef.update({ tokens: userData.tokens, purchases: userData.purchases });
        res.json({ success: true, tokens: userData.tokens, purchases: userData.purchases });
    } else {
        res.status(400).send('Insufficient tokens');
    }
});

// --- 5. ADMIN / LIBRARY API ---
app.get('/api/settings', async (req, res) => {
    const doc = await db.collection('settings').doc('main').get();
    if(doc.exists) res.json(doc.data()); else res.json({ headerTitle: 'DJ Music Library', bannerUrl: '' });
});
app.put('/api/settings', async (req, res) => {
    await db.collection('settings').doc('main').set({ headerTitle: req.body.headerTitle }, { merge: true }); res.send('Updated');
});
app.post('/api/upload-banner', upload.single('bannerFile'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file.');
    const url = await uploadToFirebase(req.file.buffer, req.file.originalname, 'dj_banners', req.file.mimetype);
    await db.collection('settings').doc('main').set({ bannerUrl: url }, { merge: true });
    res.json({ bannerUrl: url });
});

app.get('/api/songs', async (req, res) => {
    const snapshot = await db.collection('songs').orderBy('sequence').get();
    const songs = [];
    snapshot.forEach(doc => { songs.push({ id: doc.id, ...doc.data() }); });
    res.json(songs);
});

app.post('/api/upload', upload.single('mp3file'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file.');
    try {
        const url = await uploadToFirebase(req.file.buffer, req.file.originalname, 'dj_music', req.file.mimetype);
        const snapshot = await db.collection('songs').get();
        
        const newSong = {
            filename: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
            filepath: url, size: req.file.size, uploadTime: new Date().toISOString(), sequence: snapshot.size + 1, price: 10
        };
        const docRef = await db.collection('songs').add(newSong);
        res.json({ id: docRef.id, ...newSong });
    } catch(e) { res.status(500).send('Upload Failed'); }
});

app.post('/api/transload', async (req, res) => {
    const { url } = req.body; 
    if (!url || url.toLowerCase().includes('.html') || !url.toLowerCase().split('?')[0].endsWith('.m4a')) return res.status(400).send('Only .m4a URLs allowed.');
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error('HTTP Error');
        const buffer = await response.arrayBuffer();
        
        const fileUrl = await uploadToFirebase(Buffer.from(buffer), 'transloaded.m4a', 'dj_music', 'audio/mp4');
        const snapshot = await db.collection('songs').get();
        
        const newSong = { filename: 'New Transloaded Track.m4a', filepath: fileUrl, size: buffer.byteLength, uploadTime: new Date().toISOString(), sequence: snapshot.size + 1, price: 10 };
        const docRef = await db.collection('songs').add(newSong);
        res.json({ id: docRef.id, ...newSong });
    } catch (error) { res.status(400).send('Transload failed.'); }
});

app.put('/api/songs/:id/settings', async (req, res) => {
    const updates = {};
    if (req.body.newName) { let n = req.body.newName; const ext = n.includes('.m4a') ? '.m4a' : '.mp3'; if (!n.toLowerCase().endsWith(ext)) n += ext; updates.filename = n; }
    if (req.body.newPrice !== undefined) updates.price = parseInt(req.body.newPrice) || 0;
    
    await db.collection('songs').doc(req.params.id).update(updates);
    res.send('Updated');
});

app.put('/api/songs/reorder', async (req, res) => {
    const batch = db.batch();
    req.body.orderedIds.forEach((id, index) => {
        const ref = db.collection('songs').doc(id);
        batch.update(ref, { sequence: index + 1 });
    });
    await batch.commit();
    res.send('Reordered');
});

app.delete('/api/songs/:id', async (req, res) => {
    await db.collection('songs').doc(req.params.id).delete(); 
    // Re-sequence
    const snapshot = await db.collection('songs').orderBy('sequence').get();
    const batch = db.batch();
    let seq = 1;
    snapshot.forEach(doc => { batch.update(doc.ref, { sequence: seq++ }); });
    await batch.commit();
    res.send('Deleted');
});

const startApp = async () => {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Firebase Server bound to 0.0.0.0 on Port ${PORT}`);
    });
};

startApp();
