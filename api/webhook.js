const admin = require('firebase-admin');

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
    const text = message.text;

    if (text.startsWith('/start ')) {
        const userId = text.split(' ')[1];
        try {
            await db.collection('users').doc(userId).set({ tgChatId: chatId }, { merge: true });
            await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: "🎉 *Вітаю!* Твій Telegram успішно підв'язано.\n\nТепер ти можеш перевіряти свій абонемент кнопкою нижче.",
                    parse_mode: "Markdown",
                    reply_markup: {
                        keyboard: [[{ text: "Мій абонемент 💳" }]],
                        resize_keyboard: true
                    }
                })
            });
        } catch (error) {}
    }

    if (text === '/subscription' || text === 'Мій абонемент 💳') {
        console.log("Отримано команду абонемента для чату:", chatId); // ЛОГ 1
        try {
            const usersSnap = await db.collection("users").where("tgChatId", "==", chatId).get();
            
            if (usersSnap.empty) {
                console.log("Користувача з таким tgChatId не знайдено"); // ЛОГ 2
                // ... відправка повідомлення про непідв'язаний акаунт ...
                return res.status(200).send("OK");
            }
            
            const userData = usersSnap.docs[0].data();
            console.log("Знайдено користувача:", userData.email); // ЛОГ 3
            
            const sub = userData.subscription;
            if (!sub) {
                console.log("У користувача немає поля subscription"); // ЛОГ 4
                // ...
            }
            // ... решта коду
        } catch (e) {
            console.error("Помилка в обробнику:", e); // ЛОГ 5
        }
    }
    return res.status(200).send('OK');
}