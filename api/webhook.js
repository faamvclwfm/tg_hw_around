export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('OK');

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
    const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
    const PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    console.log('[Webhook] START', new Date().toISOString());

    // ── Отримати Google Access Token через JWT ──────────────────
    async function getAccessToken() {
        const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
        const now = Math.floor(Date.now() / 1000);
        const claim = btoa(JSON.stringify({
            iss: CLIENT_EMAIL,
            scope: 'https://www.googleapis.com/auth/datastore',
            aud: 'https://oauth2.googleapis.com/token',
            exp: now + 3600,
            iat: now
        }));

        const signingInput = `${header}.${claim}`;

        // Імпортуємо приватний ключ
        const pemContents = PRIVATE_KEY
            .replace('-----BEGIN PRIVATE KEY-----', '')
            .replace('-----END PRIVATE KEY-----', '')
            .replace(/\s/g, '');
        const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

        const cryptoKey = await crypto.subtle.importKey(
            'pkcs8',
            binaryKey,
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['sign']
        );

        const encoder = new TextEncoder();
        const signature = await crypto.subtle.sign(
            'RSASSA-PKCS1-v1_5',
            cryptoKey,
            encoder.encode(signingInput)
        );

        const sig = btoa(String.fromCharCode(...new Uint8Array(signature)));
        const jwt = `${signingInput}.${sig}`;

        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) {
            console.error('[Auth] Помилка отримання токена:', JSON.stringify(tokenData));
            throw new Error('No access token');
        }
        return tokenData.access_token;
    }

    // ── Firestore REST: знайти юзера по tgChatId ───────────────
    async function findUserByChatId(chatId, token) {
        const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`;
        const body = {
            structuredQuery: {
                from: [{ collectionId: 'users' }],
                where: {
                    fieldFilter: {
                        field: { fieldPath: 'tgChatId' },
                        op: 'EQUAL',
                        value: { integerValue: String(chatId) }
                    }
                },
                limit: 1
            }
        };
        const r = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const docs = await r.json();
        console.log('[Firestore] Query result:', JSON.stringify(docs).slice(0, 300));
        if (!docs[0]?.document) return null;
        return docs[0].document;
    }

    // ── Firestore REST: записати tgChatId ───────────────────────
    async function saveChatId(userId, chatId, token) {
        const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${userId}?updateMask.fieldPaths=tgChatId`;
        const r = await fetch(url, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: { tgChatId: { integerValue: String(chatId) } } })
        });
        const result = await r.json();
        console.log('[Firestore] Save result:', JSON.stringify(result).slice(0, 200));
    }

    // ── Telegram sendMessage ─────────────────────────────────────
    async function tgSend(chatId, text, extra = {}) {
        const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, ...extra })
        });
        const result = await r.json();
        if (!result.ok) console.error('[TG] Error:', JSON.stringify(result));
        return result;
    }

    // ── Парсимо update ───────────────────────────────────────────
    let update;
    try {
        update = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (e) {
        console.error('[Parse Error]', e.message);
        return res.status(200).send('OK');
    }

    let chatId, text = '';
    if (update?.message?.text) {
        chatId = update.message.chat.id;
        text = update.message.text.trim();
    } else if (update?.callback_query?.data) {
        chatId = update.callback_query.message.chat.id;
        text = update.callback_query.data.trim();
    } else {
        console.log('[Webhook] Не текстовий update');
        return res.status(200).send('OK');
    }

    console.log(`[Webhook] chatId=${chatId} text="${text}"`);

    // ── /start ───────────────────────────────────────────────────
    if (text.startsWith('/start')) {
        const userId = text.split(' ')[1];
        try {
            const token = await getAccessToken();
            if (userId) await saveChatId(userId, chatId, token);
        } catch (e) {
            console.error('[/start] Error:', e.message);
        }

        await tgSend(chatId,
            "🎉 *Вітаю!* Твій Telegram успішно підв'язано.\n\nТепер ти можеш перевіряти свій абонемент кнопкою нижче.",
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    keyboard: [[{ text: 'Мій абонемент 💳' }]],
                    resize_keyboard: true,
                    one_time_keyboard: false
                }
            }
        );
        return res.status(200).send('OK');
    }

    // ── Абонемент ────────────────────────────────────────────────
    const isSubRequest =
        text.startsWith('/subscription') ||
        text.toLowerCase().includes('абонемент');

    if (isSubRequest) {
        let token;
        try {
            token = await getAccessToken();
        } catch (e) {
            console.error('[Auth Error]', e.message);
            await tgSend(chatId, '❌ Помилка авторизації сервера. Спробуй пізніше.');
            return res.status(200).send('OK');
        }

        const doc = await findUserByChatId(chatId, token);

        if (!doc) {
            await tgSend(chatId, "❌ Акаунт не підв'язано. Перейди за посиланням з особистого кабінету та натисни /start.");
            return res.status(200).send('OK');
        }

        // Парсимо Firestore document fields
        const f = doc.fields || {};
        const name = f.name?.stringValue || f.email?.stringValue || 'Не вказано';
        const sub = f.subscription?.mapValue?.fields;

        if (!sub) {
            await tgSend(chatId, '📋 Твій абонемент ще не заповнений вчителем.');
            return res.status(200).send('OK');
        }

        const paid = Number(sub.paid?.integerValue || sub.paid?.doubleValue || 0);
        const attended = Number(sub.attended?.integerValue || sub.attended?.doubleValue || 0);
        const nextPayment = sub.nextPayment?.stringValue || 'не встановлено';
        const left = Math.max(0, paid - attended);

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
        return res.status(200).send('OK');
    }

    return res.status(200).send('OK');
}