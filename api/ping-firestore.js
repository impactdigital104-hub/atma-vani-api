const admin = require('firebase-admin');

function initFirestore() {
  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
  return admin.firestore();
}

module.exports = async (req, res) => {
  try {
    const db = initFirestore();
    const ref = await db.collection('messages').add({
      createdAt: Date.now(),
      source: 'ping-firestore',
      userMessage: 'TEST: ping',
      assistantReply: 'pong'
    });
    return res.status(200).json({ ok: true, docId: ref.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
};
