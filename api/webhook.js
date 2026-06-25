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

// ✅ FIX 1: module.exports замість "export default" (CommonJS vs ESM конфлікт)
module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('OK');

    const update = req.body;
    let chatId;
    let text = "";

    if (update.message && update.message.text) {
        // ✅ FIX 2: chatId як String — Firestore зберігає як Number, а порівнює як Number
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
                // ✅ FIX 3: зберігаємо tgChatId як Number (тип має відповідати тому, що приходить від Telegram)
                await db.collection('users').doc(userId).set({ tgChatId: Number(chatId) }, { merge: true });
            } catch (e) {
                console.error('[/start] Помилка запису в Firestore:', e);
            }
        }

        try {
            const tgRes = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
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
            // ✅ FIX 4: логуємо відповідь Telegram щоб бачити помилки
            if (!tgRes.ok) {
                const err = await tgRes.json();
                console.error('[/start] Telegram sendMessage error:', JSON.stringify(err));
            }
        } catch (e) {
            console.error('[/start] fetch error:', e);
        }
        return res.status(200).send("OK");
    }

    // ✅ FIX 5: "Мій абонемент 💳" — текст кнопки містить емодзі, перевірка була без нього
    if (
        text === '/subscription' ||
        text.startsWith('/subscription') ||
        text.includes('Мій абонемент') ||
        text.includes('абонемент')
    ) {
        try {
            // ✅ FIX 6: порівнюємо і як Number, і як String на випадок розбіжності типів у Firestore
            let usersSnap = await db.collection('users').where('tgChatId', '==', Number(chatId)).get();

            // Fallback: якщо раптом збережений як рядок
            if (usersSnap.empty) {
                usersSnap = await db.collection('users').where('tgChatId', '==', String(chatId)).get();
            }

            if (usersSnap.empty) {
                console.warn(`[subscription] Користувача з chatId=${chatId} не знайдено в Firestore`);
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

            const left = Math.max(0, (sub.paid || 0) - (sub.attended || 0));
            const responseText =
                `💳 *ТВІЙ АБОНЕМЕНТ* 💳\n\n` +
                `👤 *Учень:* ${userData.name || userData.email || 'Не вказано'}\n` +
                `📊 *Статус занять:*\n` +
                `▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬\n` +
                `🍏 Проплачено: \`${sub.paid || 0}\`\n` +
                `👟 Відвідано: \`${sub.attended || 0}\`\n` +
                `🔥 Залишилось: \`${left}\` занять\n` +
                `▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬\n` +
                `📅 *Наступна оплата до:* ${sub.nextPayment || 'не встановлено'}`;

            const tgRes = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: responseText,
                    parse_mode: 'Markdown'
                })
            });

            // ✅ FIX 4 (продовження): логуємо помилки Telegram
            if (!tgRes.ok) {
                const err = await tgRes.json();
                console.error('[subscription] Telegram sendMessage error:', JSON.stringify(err));
            }

        } catch (error) {
            console.error('[subscription] Внутрішня помилка:', error);
        }
        return res.status(200).send("OK");
    }

    return res.status(200).send("OK");
};