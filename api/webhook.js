const admin = require('firebase-admin');

// Ініціалізація Firebase Admin через змінні оточення (щоб не світити ключі)
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        })
    });
}

const db = admin.firestore();

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('OK');

    const update = req.body;
    const message = update.message;

    if (!message || !message.text) return res.status(200).send('OK');

    const chatId = message.chat.id;
    const text = message.text; // Буде мати вигляд "/start aB1c2D3eF4..."

    if (text.startsWith('/start ')) {
        const userId = text.split(' ')[1]; // Дістали UID з посилання!

        try {
            // Записуємо tgChatId в документ юзера
            await db.collection('users').doc(userId).set({
                tgChatId: chatId
            }, { merge: true });

            // Відправляємо успішну відповідь у Телеграм
            await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: "🎉 *Вітаю!* Твій Telegram успішно підв'язано до навчальної платформи.\n\nТепер ти миттєво дізнаватимешся про нові домашні завдання.",
                    parse_mode: "Markdown"
                })
            });

        } catch (error) {
            console.error(error);
        }
    }

    return res.status(200).send('OK');
}