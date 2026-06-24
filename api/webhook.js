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

    // 1. Обробка команди /start
    if (text.startsWith('/start ')) {
        const userId = text.split(' ')[1];
        try {
            await db.collection('users').doc(userId).set({ tgChatId: chatId }, { merge: true });
            
            // Відправка повідомлення з кнопкою
            await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: "🎉 *Вітаю!* Твій Telegram успішно підв'язано.\n\nТепер ти можеш перевіряти свій абонемент кнопкою нижче.",
                    parse_mode: "Markdown",
                    reply_markup: {
                        keyboard: [[{ text: "Мій абонемент 💳" }]],
                        resize_keyboard: true,
                        one_time_keyboard: false
                    }
                })
            });
        } catch (e) {
            console.error("Помилка при старті:", e);
        }
        return res.status(200).send("OK");
    }

    // 2. Обробка команди абонемента
    if (text === '/subscription' || text === 'Мій абонемент 💳') {
        try {
            const usersSnap = await db.collection('users').where('tgChatId', '==', chatId).get();

            if (usersSnap.empty) {
                await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        chat_id: chatId, 
                        text: "❌ Акаунт не підв'язано. Спробуй ще раз перейти за посиланням з особистого кабінету." 
                    })
                });
                return res.status(200).send("OK");
            }

            const userData = usersSnap.docs[0].data();
            const sub = userData.subscription;
            
            if (!sub) {
                await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        chat_id: chatId, 
                        text: "📋 Твій абонемент ще не заповнений вчителем." 
                    })
                });
                return res.status(200).send("OK");
            }

            const left = (sub.paid || 0) - (sub.attended || 0);
            const responseText = `💳 *ТВІЙ АБОНЕМЕНТ* 💳\n\n👤 *Учень:* ${userData.name || 'Учень'}\n📊 *Статус занять:*\n▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬\n🍏 Проплачено: \`${sub.paid || 0}\`\n👟 Відвідано: \`${sub.attended || 0}\`\n🔥 Залишилось: \`${left >= 0 ? left : 0}\` занять\n▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬\n📅 *Наступна оплата до:* ${sub.nextPayment || 'не встановлено'}`;

            await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    chat_id: chatId, 
                    text: responseText,
                    parse_mode: 'Markdown'
                })
            });
        } catch (error) {
            console.error("Помилка запиту абонемента:", error);
        }
        return res.status(200).send("OK");
    }

    return res.status(200).send("OK");
}