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
const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUPS_URL = 'https://diagnostictestresults-9f6ac.web.app/groups.html';
const CABINET_URL = 'https://diagnostictestresults-9f6ac.web.app/';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'around_admin';

// Тимчасовий стан для multi-step діалогу (в пам'яті, між запитами скидається — ок для простих флоу)
const adminState = {};

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

// Надсилає учню через учнівський бот (BOT_TOKEN)
async function tgSendStudent(chatId, text, extra = {}) {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, ...extra }),
    });
    const result = await r.json();
    if (!result.ok) console.error('[StudentTG] Error:', JSON.stringify(result));
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

const ADMIN_KEYBOARD = {
    keyboard: [
        [{ text: '📊 Зведення по групах' }],
        [{ text: '📋 Активні ДЗ' }, { text: '🔔 Нові здачі' }],
        [{ text: '📢 Нагадати про ДЗ' }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
};

async function handleHwSubmission(payload) {
    const { studentEmail, studentName, hwTitle, groupName, testsCount } = payload;

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
        const completedSnap = await db.collection('completed_homeworks').where('groupId', '==', doc.id).get();
        lines.push(`📁 *${data.groupName}*\n   👥 Учнів: ${membersCount} | 📋 ДЗ: ${assignSnap.size} | ✅ Здач: ${completedSnap.size}`);
    }

    await tgSend(chatId, `📊 *Зведення по групах*\n\n${lines.join('\n\n')}`, { parse_mode: 'Markdown', reply_markup: ADMIN_KEYBOARD });
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
        const completedSnap = await db.collection('completed_homeworks').where('assignmentId', '==', doc.id).get();
        lines.push(`📌 *${hw.title || 'Без назви'}*\n   📁 ${groupCache[groupId]} | 🧪 ${(hw.requiredTests || []).length} тестів | ✅ Здали: ${completedSnap.size}`);
    }

    await tgSend(chatId, `📋 *Останні 10 ДЗ:*\n\n${lines.join('\n\n')}\n\n👉 [Адмін-панель](${GROUPS_URL})`, { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: ADMIN_KEYBOARD });
}

async function handleRecentSubmissions(chatId) {
    const snap = await db.collection('completed_homeworks').orderBy('submittedAt', 'desc').limit(10).get();
    if (snap.empty) {
        await tgSend(chatId, '📭 Здач ще немає.', { reply_markup: ADMIN_KEYBOARD });
        return;
    }

    const assignCache = {};
    const lines = [];

    for (const doc of snap.docs) {
        const sub = doc.data();
        if (!assignCache[sub.assignmentId]) {
            const aDoc = await db.collection('assignments').doc(sub.assignmentId).get();
            assignCache[sub.assignmentId] = aDoc.exists ? (aDoc.data().title || 'Без назви') : 'Невідоме';
        }
        const ts = sub.submittedAt?.seconds
            ? new Date(sub.submittedAt.seconds * 1000).toLocaleString('uk-UA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kiev' })
            : '—';
        lines.push(`✅ *${sub.userEmail || 'Учень'}*\n   📌 ${assignCache[sub.assignmentId]} | 🕐 ${ts}`);
    }

    await tgSend(chatId, `🔔 *Останні 10 здач:*\n\n${lines.join('\n\n')}`, { parse_mode: 'Markdown', reply_markup: ADMIN_KEYBOARD });
}

// Показати список груп для вибору (для нагадування)
async function handleRemindStep1(chatId) {
    const groupsSnap = await db.collection('groups').get();
    if (groupsSnap.empty) {
        await tgSend(chatId, '📭 Груп ще не створено.', { reply_markup: ADMIN_KEYBOARD });
        return;
    }

    const buttons = [];
    groupsSnap.forEach(doc => {
        const name = doc.data().groupName || 'Без назви';
        buttons.push([{ text: `📁 ${name}`, callback_data: `remind_group:${doc.id}:${name}` }]);
    });
    buttons.push([{ text: '↩️ Скасувати', callback_data: 'remind_cancel' }]);

    adminState[chatId] = { step: 'choosing_group' };

    await tgSend(chatId, '📢 *Нагадати про ДЗ*\n\nОберіть групу, якій надіслати нагадування:', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons }
    });
}

// Розсилка нагадувань учням конкретної групи
async function sendHwRemindersToGroup(chatId, groupId, groupName) {
    await tgSend(chatId, `⏳ Надсилаю нагадування групі *${groupName}*...`, { parse_mode: 'Markdown' });

    const groupDoc = await db.collection('groups').doc(groupId).get();
    if (!groupDoc.exists) {
        await tgSend(chatId, '❌ Групу не знайдено.', { reply_markup: ADMIN_KEYBOARD });
        return;
    }

    const groupData = groupDoc.data();
    const members = groupData.members || [];

    if (members.length === 0) {
        await tgSend(chatId, '📭 У групі немає учнів.', { reply_markup: ADMIN_KEYBOARD });
        return;
    }

    // Завантажуємо всі ДЗ групи
    const assignSnap = await db.collection('assignments').where('groupId', '==', groupId).get();
    if (assignSnap.empty) {
        await tgSend(chatId, '📭 У групі немає домашніх завдань.', { reply_markup: ADMIN_KEYBOARD });
        return;
    }

    const allAssignments = [];
    assignSnap.forEach(d => allAssignments.push({ id: d.id, ...d.data() }));

    // Завантажуємо дані юзерів батчами
    const usersMap = {};
    const batchSize = 10;
    for (let i = 0; i < members.length; i += batchSize) {
        const chunk = members.slice(i, i + batchSize);
        const snap = await db.collection('users')
            .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
            .get();
        snap.forEach(doc => { usersMap[doc.id] = { uid: doc.id, ...doc.data() }; });
    }

    let sentCount = 0;
    let noTgCount = 0;
    let noPendingCount = 0;

    const sends = [];

    for (const userId of members) {
        const user = usersMap[userId];
        if (!user || !user.tgChatId) {
            noTgCount++;
            continue;
        }

        // Перевіряємо які ДЗ учень ще не здав
        const completedSnap = await db.collection('completed_homeworks')
            .where('groupId', '==', groupId)
            .where('userId', '==', userId)
            .get();

        const submittedIds = new Set();
        completedSnap.forEach(d => submittedIds.add(d.data().assignmentId));

        const pendingHws = allAssignments.filter(hw => !submittedIds.has(hw.id));
        pendingHws.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

        if (pendingHws.length === 0) {
            noPendingCount++;
            continue;
        }

        const hwLines = pendingHws.slice(0, 5).map((hw, i) => {
            const count = (hw.requiredTests || []).length;
            return `  ${i + 1}. 📌 *${hw.title || 'Без назви'}* (${count} тест${count === 1 ? '' : 'ів'})`;
        });

        const text =
            `📢 *Нагадування від вчителя*\n\n` +
            `У тебе є ${pendingHws.length} невиконан${pendingHws.length === 1 ? 'е' : 'их'} домашн${pendingHws.length === 1 ? 'є завдання' : 'іх завдань'}:\n\n` +
            hwLines.join('\n') +
            (pendingHws.length > 5 ? `\n  ...і ще ${pendingHws.length - 5}` : '') +
            `\n\n👉 [Виконати в кабінеті](${CABINET_URL})`;

        sends.push(
            tgSendStudent(user.tgChatId, text, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            })
            .then(() => { sentCount++; })
            .catch(e => console.error(`[StudentTG] Failed for ${user.tgChatId}:`, e.message))
        );
    }

    await Promise.allSettled(sends);

    const summary =
        `✅ *Нагадування надіслано!*\n\n` +
        `📁 Група: *${groupName}*\n` +
        `📨 Отримали: *${sentCount}* учнів\n` +
        (noPendingCount > 0 ? `✅ Вже виконали всі ДЗ: ${noPendingCount}\n` : '') +
        (noTgCount > 0 ? `⚠️ Без Telegram: ${noTgCount}` : '');

    await tgSend(chatId, summary, { parse_mode: 'Markdown', reply_markup: ADMIN_KEYBOARD });
}

async function handleUpdate(update) {
    let chatId, text = '', callbackData = '', callbackQueryId = '';

    if (update?.message?.text) {
        chatId = update.message.chat.id;
        text = update.message.text.trim();
    } else if (update?.callback_query) {
        chatId = update.callback_query.message.chat.id;
        callbackData = update.callback_query.data || '';
        callbackQueryId = update.callback_query.id;

        // Відповідаємо на callback щоб кнопка не "крутилась"
        await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackQueryId })
        });
    } else {
        return;
    }

    // Обробка callback від inline-кнопок
    if (callbackData) {
        const isAdmin = (await db.collection('admins').doc(String(chatId)).get()).exists;
        if (!isAdmin) return;

        if (callbackData === 'remind_cancel') {
            delete adminState[chatId];
            await tgSend(chatId, '↩️ Скасовано.', { reply_markup: ADMIN_KEYBOARD });
            return;
        }

        if (callbackData.startsWith('remind_group:')) {
            const parts = callbackData.split(':');
            const groupId = parts[1];
            const groupName = parts.slice(2).join(':');
            delete adminState[chatId];
            await sendHwRemindersToGroup(chatId, groupId, groupName);
            return;
        }

        return;
    }

    // Обробка текстових повідомлень
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
            `👋 *Вітаю, адміне!* Бот підключено.\n\nТи отримуватимеш сповіщення щоразу, коли учень здасть домашнє завдання.\n\nТакож можеш переглядати статистику та надсилати нагадування 👇`,
            { parse_mode: 'Markdown', reply_markup: ADMIN_KEYBOARD }
        );
        return;
    }

    const isAdmin = (await db.collection('admins').doc(String(chatId)).get()).exists;
    if (!isAdmin) {
        await tgSend(chatId, '❌ Ви не авторизовані. Зверніться до розробника.');
        return;
    }

    if (text.includes('Зведення')) { await handleSummary(chatId); return; }
    if (text.includes('Активні ДЗ')) { await handleActiveHw(chatId); return; }
    if (text.includes('Нові здачі')) { await handleRecentSubmissions(chatId); return; }
    if (text.includes('Нагадати про ДЗ')) { await handleRemindStep1(chatId); return; }

    await tgSend(chatId, 'Обирай дію нижче 👇', { reply_markup: ADMIN_KEYBOARD });
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    if (req.method !== 'POST') { res.status(200).send('OK'); return; }

    let body;
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (e) {
        res.status(200).send('OK');
        return;
    }

    const action = req.query?.action || '';

    if (action === 'hw_submitted') {
        try { await handleHwSubmission(body); } catch (e) { console.error('[HwSubmission]', e.message); }
        res.status(200).send('OK');
        return;
    }

    try { await handleUpdate(body); } catch (e) { console.error('[AdminHandler]', e.message); }

    res.status(200).send('OK');
};