// Shows whether required env vars are present (does NOT reveal values)
module.exports = async (req, res) => {
  const keys = [
    'OPENAI_API_KEY',
    'FIREBASE_PROJECT_ID',
    'FIREBASE_CLIENT_EMAIL',
    'FIREBASE_PRIVATE_KEY'
  ];
  const present = Object.fromEntries(keys.map(k => [k, !!process.env[k]]));
  res.status(200).json({ present });
};
