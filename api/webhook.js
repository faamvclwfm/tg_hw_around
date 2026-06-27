const admin = require('firebase-admin');

// ── Ініціалізація Firebase Admin (один раз) ──────────────────
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId:   process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
    });
}

const db = admin.firestore();
const BOT_TOKEN = process.env.BOT_TOKEN;

// ── Telegram sendMessage ──────────────────────────────────────
async function tgSend(chatId, text, extra = {}) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, ...extra }),
    });
    const result = await r.json();
    if (!result.ok) console.error('[TG] Помилка:', JSON.stringify(result));
    return result;
}

// ── Firestore: записати tgChatId у юзера ─────────────────────
async function saveChatId(userId, chatId) {
    await db.collection('users').doc(userId).set(
        { tgChatId: String(chatId) },
        { merge: true }
    );
    console.log(`[Firestore] tgChatId збережено: userId=${userId}, chatId=${chatId}`);
}

// ── Firestore: знайти юзера по tgChatId ──────────────────────
async function findUserByChatId(chatId) {
    const snap = await db.collection('users')
        .where('tgChatId', '==', String(chatId))
        .limit(1)
        .get();
    if (snap.empty) return null;
    return snap.docs[0].data();
}

// ── Головний обробник ─────────────────────────────────────────
module.exports = async function handler(req, res) {
    // Vercel очікує відповідь 200 якомога швидше
    res.status(200).send('OK');

    if (req.method !== 'POST') return;

    console.log('[Webhook] START', new Date().toISOString());

    // Парсимо update
    let update;
    try {
        update = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (e) {
        console.error('[Parse Error]', e.message);
        return;
    }

    let chatId, text = '';
    if (update?.message?.text) {
        chatId = update.message.chat.id;
        text = update.message.text.trim();
    } else if (update?.callback_query?.data) {
        chatId = update.callback_query.message.chat.id;
        text = update.callback_query.data.trim();
    } else {
        console.log('[Webhook] Не текстовий update, ігноруємо');
        return;
    }

    console.log(`[Webhook] chatId=${chatId} text="${text}"`);

    try {
        // ── /start ──────────────────────────────────────────────
        if (text.startsWith('/start')) {
            const userId = text.split(' ')[1];
            if (userId) {
                await saveChatId(userId, chatId);
            }

            await tgSend(chatId,
                "🎉 *Вітаю!* Твій Telegram успішно підв'язано.\n\nТепер ти можеш перевіряти свій абонемент кнопкою нижче.",
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        keyboard: [[{ text: 'Мій абонемент 💳' }]],
                        resize_keyboard: true,
                        one_time_keyboard: false,
                    },
                }
            );
            return;
        }

        // ── Абонемент ────────────────────────────────────────────
        const isSubRequest =
            text.startsWith('/subscription') ||
            text.toLowerCase().includes('абонемент');

        if (isSubRequest) {
            const userData = await findUserByChatId(chatId);

            if (!userData) {
                await tgSend(chatId,
                    "❌ Акаунт не підв'язано.\n\nПерейди за посиланням з особистого кабінету та натисни /start."
                );
                return;
            }

            const sub = userData.subscription;
            if (!sub) {
                await tgSend(chatId, '📋 Твій абонемент ще не заповнений вчителем.');
                return;
            }

            const name        = userData.name || userData.email || 'Не вказано';
            const paid        = Number(sub.paid     || 0);
            const attended    = Number(sub.attended || 0);
            const nextPayment = sub.nextPayment || 'не встановлено';
            const left        = Math.max(0, paid - attended);

            const responseText =
                `💳 *ТВІЙ АБОНЕМЕНТ* 💳\n\n` +
                `👤 *Учень:* ${name}\n` +
                `📊 *Статус занять:*\n` +
                `▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬\n` +
                `🍏 Проплачено: \`${paid}\`\n` +
                `👟 Відвідано: \`${attended}\`\n` +
                `🔥 Залишилось: \`${left}\` занять\n` +
                `▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬\n` +
                `📅 *Наступна оплата до:* ${nextPayment}`;

            await tgSend(chatId, responseText, { parse_mode: 'Markdown' });
            return;
        }

    } catch (e) {
        console.error('[Handler Error]', e.message, e.stack);
        // Намагаємось повідомити юзера про помилку
        try {
            await tgSend(chatId, '⚠️ Сталася помилка на сервері. Спробуй ще раз.');
        } catch (_) {}
    }
};