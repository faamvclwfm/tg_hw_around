import admin from 'firebase-admin';

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

async function sendTelegramMessage(chatId, text, extra = {}) {
    const res = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, ...extra })
    });
    if (!res.ok) {
        const err = await res.json();
        console.error('[Telegram API Error]', JSON.stringify(err));
    }
    return res;
}

export default async function handler(req, res) {
    // Vercel іноді шле GET для health-check
    if (req.method !== 'POST') return res.status(200).send('OK');

    let update;
    try {
        // Якщо body вже розпарсений Vercel — беремо як є, інакше парсимо вручну
        update = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (e) {
        console.error('[Parse Error]', e);
        return res.status(200).send('OK');
    }

    if (!update) {
        console.error('[No body]');
        return res.status(200).send('OK');
    }

    let chatId;
    let text = "";

    if (update.message && update.message.text) {
        chatId = update.message.chat.id;
        text = update.message.text.trim();
    } else if (update.callback_query && update.callback_query.data) {
        chatId = update.callback_query.message.chat.id;
        text = update.callback_query.data.trim();
    } else {
        console.log('[Webhook] Update без тексту:', JSON.stringify(update));
        return res.status(200).send('OK');
    }

    console.log(`[Webhook] chatId=${chatId} text="${text}"`);

    // ─── /start ───────────────────────────────────────────────────
    if (text.startsWith('/start')) {
        const parts = text.split(' ');
        if (parts.length > 1) {
            const userId = parts[1];
            try {
                // Зберігаємо як Number — саме такого типу chatId від Telegram
                await db.collection('users').doc(userId).set(
                    { tgChatId: Number(chatId) },
                    { merge: true }
                );
                console.log(`[/start] tgChatId=${chatId} збережено для userId=${userId}`);
            } catch (e) {
                console.error('[/start] Firestore error:', e);
            }
        }

        await sendTelegramMessage(
            chatId,
            "🎉 *Вітаю!* Твій Telegram успішно підв'язано.\n\nТепер ти можеш перевіряти свій абонемент кнопкою нижче.",
            {
                parse_mode: "Markdown",
                reply_markup: {
                    keyboard: [[{ text: "Мій абонемент 💳" }]],
                    resize_keyboard: true,
                    one_time_keyboard: false
                }
            }
        );
        return res.status(200).send("OK");
    }

    // ─── /subscription або кнопка "Мій абонемент 💳" ──────────────
    const isSubscriptionRequest =
        text.startsWith('/subscription') ||
        text.includes('абонемент') ||
        text.includes('Абонемент');

    if (isSubscriptionRequest) {
        try {
            // Шукаємо спочатку як Number (стандарт), потім як String (fallback)
            let usersSnap = await db.collection('users')
                .where('tgChatId', '==', Number(chatId))
                .get();

            if (usersSnap.empty) {
                console.warn(`[subscription] Не знайдено за Number(${chatId}), пробую String...`);
                usersSnap = await db.collection('users')
                    .where('tgChatId', '==', String(chatId))
                    .get();
            }

            if (usersSnap.empty) {
                console.warn(`[subscription] Користувача chatId=${chatId} не знайдено взагалі`);
                await sendTelegramMessage(chatId,
                    "❌ Акаунт не підв'язано. Перейди за посиланням з особистого кабінету та натисни /start."
                );
                return res.status(200).send("OK");
            }

            const userData = usersSnap.docs[0].data();
            console.log(`[subscription] Знайдено користувача: ${userData.email || userData.name}`);

            const sub = userData.subscription;

            if (!sub) {
                await sendTelegramMessage(chatId, "📋 Твій абонемент ще не заповнений вчителем.");
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

            await sendTelegramMessage(chatId, responseText, { parse_mode: 'Markdown' });

        } catch (error) {
            console.error('[subscription] Помилка:', error);
        }
        return res.status(200).send("OK");
    }

    return res.status(200).send("OK");
}// redeploy Thu Jun 25 13:30:46 EEST 2026
