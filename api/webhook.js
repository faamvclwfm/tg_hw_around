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
    let chatId;
    let text = "";

    if (update.message && update.message.text) {
        chatId = update.message.chat.id;
        text = update.message.text.trim();
    } else if (update.callback_query && update.callback_query.data) {
        chatId = update.callback_query.message.chat.id;
        text = update.callback_query.data.trim();
    } else {
        return res.status(200).send('OK');
    }

    if (text.startsWith('/start')) {
        const parts = text.split(' ');
        if (parts.length > 1) {
            const userId = parts[1];
            try {
                await db.collection('users').doc(userId).set({ tgChatId: chatId }, { merge: true });
            } catch (e) {
                console.error(e);
            }
        }
        
        try {
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
            console.error(e);
        }
        return res.status(200).send("OK");
    }

    if (text.includes('/subscription') || text.includes('Мій абонемент') || text.includes('Абонемент')) {
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
            const responseText = `💳 *ТВІЙ АБОНЕМЕНТ* 💳\n\n👤 *Учень:* ${userData.name || userData.email || 'Не вказано'}\n📊 *Статус занять:*\n▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬\n🍏 Проплачено: \`${sub.paid || 0}\`\n👟 Відвідано: \`${sub.attended || 0}\`\n🔥 Залишилось: \`${left >= 0 ? left : 0}\` занять\n▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬\n📅 *Наступна оплата до:* ${sub.nextPayment || 'не встановлено'}`;

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
            console.error(error);
        }
        return res.status(200).send("OK");
    }

    return res.status(200).send("OK");
}