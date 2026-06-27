
const admin = require('firebase-admin');

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
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const GROUPS_URL = 'https://diagnostictestresults-9f6ac.web.app/groups.html';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'around_admin';

async function tgSend(chatId, text, extra = {}) {
    const r = await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, ...extra }),
    });
    const result = await r.json();
    if (!result.ok) console.error('[AdminTG] Error:', JSON.stringify(result));
    return result;
}

async function getAdminChatIds() {
    const snap = await db.collection('admins').get();
    const ids = [];
    snap.forEach(doc => {
        if (doc.data().tgChatId) ids.push(doc.data().tgChatId);
    });
    return ids;
}

function formatDate(dateStr) {
    const months = ['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'];
    const [y, m, d] = dateStr.split('-');
    return `${parseInt(d)} ${months[parseInt(m) - 1]}`;
}

const ADMIN_KEYBOARD = {
    keyboard: [
        [{ text: '📊 Зведення по групах' }],
        [{ text: '📋 Активні ДЗ' }, { text: '🔔 Нові здачі' }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
};

async function handleHwSubmission(payload) {
    const { studentEmail, studentName, hwTitle, groupName, testsCount, assignmentId } = payload;

    const adminChatIds = await getAdminChatIds();
    if (adminChatIds.length === 0) return;

    const now = new Date();
    const timeStr = now.toLocaleString('uk-UA', {
        day: 'numeric', month: 'long',
        hour: '2-digit', minute: '2-digit',
        timeZone: 'Europe/Kiev'
    });

    const text =
        `✅ *Нова здача ДЗ!*\n\n` +
        `👤 *Учень:* ${studentName || studentEmail}\n` +
        `📌 *Завдання:* ${hwTitle}\n` +
        `📚 *Група:* ${groupName || 'Невідома'}\n` +
        `🧪 *Тестів у завданні:* ${testsCount || '—'}\n` +
        `🕐 *Час здачі:* ${timeStr}\n\n` +
        `👉 [Переглянути в адмінці](${GROUPS_URL})`;

    await Promise.allSettled(
        adminChatIds.map(chatId =>
            tgSend(chatId, text, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
                reply_markup: ADMIN_KEYBOARD
            })
        )
    );
}

async function handleSummary(chatId) {
    const groupsSnap = await db.collection('groups').get();
    if (groupsSnap.empty) {
        await tgSend(chatId, '📭 Груп ще не створено.', { reply_markup: ADMIN_KEYBOARD });
        return;
    }

    const lines = [];
    for (const doc of groupsSnap.docs) {
        const data = doc.data();
        const membersCount = (data.members || []).length;

        const assignSnap = await db.collection('assignments').where('groupId', '==', doc.id).get();
        const totalHw = assignSnap.size;

        const completedSnap = await db.collection('completed_homeworks').where('groupId', '==', doc.id).get();
        const totalSubmissions = completedSnap.size;

        lines.push(
            `📁 *${data.groupName}*\n` +
            `   👥 Учнів: ${membersCount} | 📋 ДЗ: ${totalHw} | ✅ Здач: ${totalSubmissions}`
        );
    }

    await tgSend(chatId,
        `📊 *Зведення по групах*\n\n${lines.join('\n\n')}`,
        { parse_mode: 'Markdown', reply_markup: ADMIN_KEYBOARD }
    );
}

async function handleActiveHw(chatId) {
    const assignSnap = await db.collection('assignments').orderBy('createdAt', 'desc').limit(10).get();
    if (assignSnap.empty) {
        await tgSend(chatId, '📭 Активних завдань немає.', { reply_markup: ADMIN_KEYBOARD });
        return;
    }

    const groupCache = {};
    const lines = [];

    for (const doc of assignSnap.docs) {
        const hw = doc.data();
        const groupId = hw.groupId;

        if (!groupCache[groupId]) {
            const gDoc = await db.collection('groups').doc(groupId).get();
            groupCache[groupId] = gDoc.exists ? gDoc.data().groupName : 'Невідома';
        }

        const testsCount = (hw.requiredTests || []).length;
        const completedSnap = await db.collection('completed_homeworks').where('assignmentId', '==', doc.id).get();

        lines.push(
            `📌 *${hw.title || 'Без назви'}*\n` +
            `   📁 ${groupCache[groupId]} | 🧪 ${testsCount} тестів | ✅ Здали: ${completedSnap.size}`
        );
    }

    await tgSend(chatId,
        `📋 *Останні 10 ДЗ:*\n\n${lines.join('\n\n')}\n\n👉 [Адмін-панель](${GROUPS_URL})`,
        { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: ADMIN_KEYBOARD }
    );
}

async function handleRecentSubmissions(chatId) {
    const snap = await db.collection('completed_homeworks')
        .orderBy('submittedAt', 'desc')
        .limit(10)
        .get();

    if (snap.empty) {
        await tgSend(chatId, '📭 Здач ще немає.', { reply_markup: ADMIN_KEYBOARD });
        return;
    }

    const assignCache = {};
    const lines = [];

    for (const doc of snap.docs) {
        const sub = doc.data();
        const assignId = sub.assignmentId;

        if (!assignCache[assignId]) {
            const aDoc = await db.collection('assignments').doc(assignId).get();
            assignCache[assignId] = aDoc.exists ? (aDoc.data().title || 'Без назви') : 'Невідоме';
        }

        const ts = sub.submittedAt?.seconds
            ? new Date(sub.submittedAt.seconds * 1000).toLocaleString('uk-UA', {
                day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kiev'
              })
            : '—';

        lines.push(`✅ *${sub.userEmail || 'Учень'}*\n   📌 ${assignCache[assignId]} | 🕐 ${ts}`);
    }

    await tgSend(chatId,
        `🔔 *Останні 10 здач:*\n\n${lines.join('\n\n')}`,
        { parse_mode: 'Markdown', reply_markup: ADMIN_KEYBOARD }
    );
}

async function handleUpdate(update) {
    let chatId, text = '';

    if (update?.message?.text) {
        chatId = update.message.chat.id;
        text = update.message.text.trim();
    } else {
        return;
    }

    console.log(`[AdminWebhook] chatId=${chatId} text="${text}"`);

    if (text.startsWith('/start')) {
        const secret = text.split(' ')[1];

        if (secret !== ADMIN_SECRET) {
            await tgSend(chatId, '❌ Доступ заборонено. Зверніться до розробника.');
            return;
        }

        await db.collection('admins').doc(String(chatId)).set({
            tgChatId: String(chatId),
            addedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        await tgSend(chatId,
            `👋 *Вітаю, адміне!* Бот підключено.\n\nТи отримуватимеш сповіщення щоразу, коли учень здасть домашнє завдання.\n\nТакож можеш переглядати статистику нижче 👇`,
            { parse_mode: 'Markdown', reply_markup: ADMIN_KEYBOARD }
        );
        return;
    }

    const isAdmin = (await db.collection('admins').doc(String(chatId)).get()).exists;
    if (!isAdmin) {
        await tgSend(chatId, '❌ Ви не авторизовані. Зверніться до розробника.');
        return;
    }

    if (text.includes('Зведення')) {
        await handleSummary(chatId);
        return;
    }

    if (text.includes('Активні ДЗ')) {
        await handleActiveHw(chatId);
        return;
    }

    if (text.includes('Нові здачі')) {
        await handleRecentSubmissions(chatId);
        return;
    }

    await tgSend(chatId, 'Обирай дію нижче 👇', { reply_markup: ADMIN_KEYBOARD });
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(200).send('OK');
        return;
    }

    let body;
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (e) {
        console.error('[AdminParse Error]', e.message);
        res.status(200).send('OK');
        return;
    }

    const action = req.query?.action || '';

    if (action === 'hw_submitted') {
        try {
            await handleHwSubmission(body);
        } catch (e) {
            console.error('[HwSubmission Error]', e.message, e.stack);
        }
        res.status(200).send('OK');
        return;
    }

    try {
        await handleUpdate(body);
    } catch (e) {
        console.error('[AdminHandler Error]', e.message, e.stack);
    }

    res.status(200).send('OK');
};