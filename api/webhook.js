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
const BOT_TOKEN = process.env.BOT_TOKEN;
const CABINET_URL = 'https://diagnostictestresults-9f6ac.web.app/';
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

async function tgSend(chatId, text, extra = {}) {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, ...extra }),
    });
    const result = await r.json();
    if (!result.ok) console.error('[TG] Error:', JSON.stringify(result));
    return result;
}

function isAdmin(chatId) {
    return ADMIN_CHAT_IDS.includes(String(chatId));
}

async function findUserByChatId(chatId) {
    const snap = await db.collection('users')
        .where('tgChatId', '==', String(chatId))
        .limit(1)
        .get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    const userData = { uid: doc.id, ...doc.data() };

    if (!userData.groupId) {
        const groupSnap = await db.collection('groups')
            .where('members', 'array-contains', doc.id)
            .limit(1)
            .get();
        if (!groupSnap.empty) {
            userData.groupId = groupSnap.docs[0].id;
            await db.collection('users').doc(doc.id).set({ groupId: userData.groupId }, { merge: true });
        }
    }

    return userData;
}

async function getNextLessons(groupId, count = 5) {
    const groupDoc = await db.collection('groups').doc(groupId).get();
    if (!groupDoc.exists) return [];

    const schedule = groupDoc.data().schedule || {};
    const recurring = schedule.recurring || [];
    const exceptions = schedule.exceptions || {};

    const lessons = [];
    const today = new Date();

    for (let i = 0; i < 30 && lessons.length < count; i++) {
        const date = new Date(today);
        date.setDate(today.getDate() + i);

        let dow = date.getDay();
        if (dow === 0) dow = 7;

        const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        const exception = exceptions[dateStr];

        if (exception) {
            if (exception.status === 'cancelled' || exception.status === 'rescheduled') continue;
            if (['scheduled', 'conducted', 'milestone'].includes(exception.status)) {
                lessons.push({ dateStr, time: exception.time || '—', status: exception.status });
                continue;
            }
        }

        const rec = recurring.find(r => r.day === dow);
        if (rec) {
            lessons.push({ dateStr, time: rec.time || '—', status: 'scheduled' });
        }
    }

    return lessons;
}

async function getActiveHomeworks(groupId, userId) {
    const snap = await db.collection('assignments')
        .where('groupId', '==', groupId)
        .get();

    if (snap.empty) return [];

    const completedSnap = await db.collection('completed_homeworks')
        .where('groupId', '==', groupId)
        .where('userId', '==', userId)
        .get();

    const submittedIds = new Set();
    completedSnap.forEach(d => submittedIds.add(d.data().assignmentId));

    const active = [];
    snap.forEach(d => {
        if (!submittedIds.has(d.id)) {
            active.push({ id: d.id, ...d.data() });
        }
    });

    active.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    return active.slice(0, 5);
}

async function getProgress(userId) {
    const snap = await db.collection('completed_tasks')
        .where('userId', '==', userId)
        .get();

    let totalScore = 0;
    let totalMax = 0;
    let count = 0;

    snap.forEach(d => {
        const data = d.data();
        const score = Number(data.score ?? data.testResult ?? 0);
        const max = Number(data.maxScore ?? data.testQuestionsQuantity ?? 0);
        if (max > 0) {
            totalScore += score;
            totalMax   += max;
            count++;
        }
    });

    const percent = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0;
    return { count, percent };
}

function formatDate(dateStr) {
    const months = ['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'];
    const [y, m, d] = dateStr.split('-');
    return `${parseInt(d)} ${months[parseInt(m) - 1]}`;
}

const MAIN_KEYBOARD = {
    keyboard: [
        [{ text: 'Мій абонемент 💳' }, { text: 'Домашні завдання 📚' }],
        [{ text: 'Розклад 📅' },        { text: 'Мій прогрес 📊' }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
};

const ADMIN_KEYBOARD = {
    keyboard: [
        [{ text: '👥 Групи та учні' }, { text: '📋 ДЗ по групах' }],
        [{ text: '📊 Загальна статистика' }, { text: '🔔 Розіслати нагадування' }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
};

async function handleAdminUpdate(chatId, text) {
    const t = text.toLowerCase();

    if (text === '👥 Групи та учні' || t.includes('/groups')) {
        const snap = await db.collection('groups').orderBy('createdAt', 'desc').get();
        if (snap.empty) {
            await tgSend(chatId, '📭 Груп ще немає.', { reply_markup: ADMIN_KEYBOARD });
            return;
        }
        const lines = [];
        snap.forEach(doc => {
            const d = doc.data();
            const count = (d.members || []).length;
            lines.push(`📂 *${d.groupName}*\n   Учнів: ${count}`);
        });
        await tgSend(chatId,
            `👥 *Список груп:*\n\n${lines.join('\n\n')}`,
            { parse_mode: 'Markdown', reply_markup: ADMIN_KEYBOARD }
        );
        return;
    }

    if (text === '📋 ДЗ по групах' || t.includes('/assignments')) {
        const groupsSnap = await db.collection('groups').get();
        if (groupsSnap.empty) {
            await tgSend(chatId, '📭 Груп ще немає.', { reply_markup: ADMIN_KEYBOARD });
            return;
        }

        const lines = [];
        for (const groupDoc of groupsSnap.docs) {
            const groupName = groupDoc.data().groupName;
            const aSnap = await db.collection('assignments').where('groupId', '==', groupDoc.id).get();
            const hwLines = [];
            aSnap.forEach(d => {
                const data = d.data();
                const reqCount = (data.requiredTests || []).length;
                hwLines.push(`  • ${data.title || 'Без назви'} — ${reqCount} тестів`);
            });
            if (hwLines.length > 0) {
                lines.push(`📂 *${groupName}:*\n${hwLines.join('\n')}`);
            } else {
                lines.push(`📂 *${groupName}:* немає ДЗ`);
            }
        }

        await tgSend(chatId,
            `📋 *Домашні завдання по групах:*\n\n${lines.join('\n\n')}`,
            { parse_mode: 'Markdown', reply_markup: ADMIN_KEYBOARD }
        );
        return;
    }

    if (text === '📊 Загальна статистика' || t.includes('/stats')) {
        const usersSnap = await db.collection('users').get();
        const groupsSnap = await db.collection('groups').get();
        const assignSnap = await db.collection('assignments').get();
        const completedSnap = await db.collection('completed_homeworks').get();

        const usersCount = usersSnap.size;
        const groupsCount = groupsSnap.size;
        const hwCount = assignSnap.size;
        const submittedCount = completedSnap.size;

        await tgSend(chatId,
            `📊 *Загальна статистика:*\n\n` +
            `👤 Учнів: *${usersCount}*\n` +
            `📂 Груп: *${groupsCount}*\n` +
            `📋 ДЗ призначено: *${hwCount}*\n` +
            `✅ ДЗ здано: *${submittedCount}*\n\n` +
            `👉 [Відкрити адмінку](${CABINET_URL}groups.html)`,
            { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: ADMIN_KEYBOARD }
        );
        return;
    }

    if (text === '🔔 Розіслати нагадування' || t.includes('/remind')) {
        await tgSend(chatId,
            `🔔 Надішліть повідомлення у форматі:\n\n` +
            `/broadcast Текст нагадування для всіх учнів`,
            { reply_markup: ADMIN_KEYBOARD }
        );
        return;
    }

    if (text.startsWith('/broadcast ')) {
        const msg = text.slice('/broadcast '.length).trim();
        if (!msg) {
            await tgSend(chatId, '❌ Текст повідомлення порожній.', { reply_markup: ADMIN_KEYBOARD });
            return;
        }

        const usersSnap = await db.collection('users').get();
        let sent = 0;
        const promises = [];
        usersSnap.forEach(doc => {
            const data = doc.data();
            if (data.tgChatId && String(data.tgChatId) !== String(chatId)) {
                promises.push(
                    tgSend(data.tgChatId, `📢 *Повідомлення від вчителя:*\n\n${msg}`, { parse_mode: 'Markdown' })
                        .then(() => sent++)
                        .catch(() => {})
                );
            }
        });
        await Promise.all(promises);

        await tgSend(chatId, `✅ Надіслано *${sent}* учням.`, { parse_mode: 'Markdown', reply_markup: ADMIN_KEYBOARD });
        return;
    }

    await tgSend(chatId, 'Оберіть дію 👇', { reply_markup: ADMIN_KEYBOARD });
}

async function handleUpdate(update) {
    let chatId, text = '';

    if (update?.message?.text) {
        chatId = update.message.chat.id;
        text = update.message.text.trim();
    } else if (update?.callback_query?.data) {
        chatId = update.callback_query.message.chat.id;
        text = update.callback_query.data.trim();
    } else {
        return;
    }

    console.log(`[Webhook] chatId=${chatId} text="${text}"`);

    if (text.startsWith('/start')) {
        const userId = text.split(' ')[1];
        if (userId) {
            await db.collection('users').doc(userId).set(
                { tgChatId: String(chatId) },
                { merge: true }
            );
        }

        if (isAdmin(chatId)) {
            await tgSend(chatId,
                "🔐 *Вітаю, адміне!* Ти у панелі керування.\n\nОбирай дію 👇",
                { parse_mode: 'Markdown', reply_markup: ADMIN_KEYBOARD }
            );
        } else {
            await tgSend(chatId,
                "🎉 *Вітаю!* Твій Telegram успішно підв'язано.\n\nОбирай що тебе цікавить 👇",
                { parse_mode: 'Markdown', reply_markup: MAIN_KEYBOARD }
            );
        }
        return;
    }

    if (isAdmin(chatId)) {
        await handleAdminUpdate(chatId, text);
        return;
    }

    const t = text.toLowerCase();
    const isAbonement = t.includes('абонемент') || text.startsWith('/subscription');
    const isHomework  = t.includes('домашн')    || text.startsWith('/homework');
    const isSchedule  = t.includes('розклад')   || text.startsWith('/schedule');
    const isProgress  = t.includes('прогрес')   || text.startsWith('/progress');

    if (!isAbonement && !isHomework && !isSchedule && !isProgress) {
        await tgSend(chatId, 'Обирай що тебе цікавить 👇', { reply_markup: MAIN_KEYBOARD });
        return;
    }

    const userData = await findUserByChatId(chatId);

    if (!userData) {
        await tgSend(chatId,
            "❌ Акаунт не підв'язано.\n\nПерейди в особистий кабінет і натисни кнопку підключення Telegram.",
            { reply_markup: MAIN_KEYBOARD }
        );
        return;
    }

    if (isAbonement) {
        const sub = userData.subscription;
        if (!sub) {
            await tgSend(chatId, '📋 Абонемент ще не заповнений вчителем.', { reply_markup: MAIN_KEYBOARD });
            return;
        }

        const name     = userData.name || userData.email || 'Учень';
        const paid     = Number(sub.paid     || 0);
        const attended = Number(sub.attended || 0);
        const left     = Math.max(0, paid - attended);
        const next     = sub.nextPayment || 'не вказано';
        const warning  = left === 0 ? '\n\n⚠️ *Поповни абонемент!*' : left <= 2 ? `\n\n⚡ Залишилось лише ${left} — скоро поповнити.` : '';

        await tgSend(chatId,
            `💳 *АБОНЕМЕНТ*\n\n👤 ${name}\n` +
            `▬▬▬▬▬▬▬▬▬▬\n` +
            `🍏 Оплачено:   \`${paid}\`\n` +
            `👟 Відвідано:  \`${attended}\`\n` +
            `🔥 Залишилось: \`${left}\`\n` +
            `▬▬▬▬▬▬▬▬▬▬\n` +
            `📅 Наступна оплата: *${next}*` + warning,
            { parse_mode: 'Markdown', reply_markup: MAIN_KEYBOARD }
        );
        return;
    }

    const groupId = userData.groupId;

    if (isHomework) {
        if (!groupId) {
            await tgSend(chatId, '📭 Тебе ще не додано до жодного класу.', { reply_markup: MAIN_KEYBOARD });
            return;
        }

        const hws = await getActiveHomeworks(groupId, userData.uid);

        if (hws.length === 0) {
            await tgSend(chatId, '✅ Активних домашніх завдань немає. Так тримати!', { reply_markup: MAIN_KEYBOARD });
            return;
        }

        const lines = hws.map((hw, i) => {
            const count = (hw.requiredTests || []).length;
            return `${i + 1}. 📌 *${hw.title || 'Без назви'}*\n    Тестів: ${count}`;
        });

        await tgSend(chatId,
            `📚 *Активні домашні завдання:*\n\n${lines.join('\n\n')}\n\n👉 [Перейти в кабінет](${CABINET_URL})`,
            { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: MAIN_KEYBOARD }
        );
        return;
    }

    if (isSchedule) {
        if (!groupId) {
            await tgSend(chatId, '📭 Тебе ще не додано до жодного класу.', { reply_markup: MAIN_KEYBOARD });
            return;
        }

        const lessons = await getNextLessons(groupId);

        if (lessons.length === 0) {
            await tgSend(chatId, '📅 Найближчих занять не знайдено.', { reply_markup: MAIN_KEYBOARD });
            return;
        }

        const emoji = { scheduled: '📍', conducted: '✅', milestone: '🚩' };
        const lines = lessons.map(l => `${emoji[l.status] || '📍'} *${formatDate(l.dateStr)}* — ${l.time}`);

        await tgSend(chatId,
            `📅 *Найближчі заняття:*\n\n${lines.join('\n')}`,
            { parse_mode: 'Markdown', reply_markup: MAIN_KEYBOARD }
        );
        return;
    }

    if (isProgress) {
        const { count, percent } = await getProgress(userData.uid);
        const bar     = Math.round(percent / 10);
        const filled  = '🟩'.repeat(bar);
        const empty   = '⬜'.repeat(10 - bar);
        const comment = percent >= 80 ? '🔥 Чудовий результат!' : percent >= 50 ? '💪 Непогано, є куди рости!' : '📈 Практикуйся більше!';

        await tgSend(chatId,
            `📊 *Мій прогрес*\n\n` +
            `Тестів пройдено: *${count}*\n` +
            `Середній результат: *${percent}%*\n\n` +
            `${filled}${empty}\n\n` +
            `${comment}\n\n` +
            `👉 [Детально в кабінеті](${CABINET_URL})`,
            { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: MAIN_KEYBOARD }
        );
        return;
    }
}

async function sendEveningReminders() {
    try {
        const groupsSnap = await db.collection('groups').get();

        for (const groupDoc of groupsSnap.docs) {
            const groupData = groupDoc.data();
            const schedule = groupData.schedule || {};
            const recurring = schedule.recurring || [];
            const exceptions = schedule.exceptions || {};
            const members = groupData.members || [];

            if (members.length === 0) continue;

            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);

            let dow = tomorrow.getDay();
            if (dow === 0) dow = 7;

            const dateStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
            const exception = exceptions[dateStr];

            let lessonTime = null;

            if (exception) {
                if (exception.status === 'cancelled' || exception.status === 'rescheduled') continue;
                if (['scheduled', 'conducted', 'milestone'].includes(exception.status)) {
                    lessonTime = exception.time || '—';
                }
            } else {
                const rec = recurring.find(r => r.day === dow);
                if (rec) lessonTime = rec.time || '—';
            }

            if (!lessonTime) continue;

            const usersSnap = await db.collection('users')
                .where(admin.firestore.FieldPath.documentId(), 'in', members.slice(0, 10))
                .get();

            const activeHws = await db.collection('assignments').where('groupId', '==', groupDoc.id).get();
            const completedSnap = await db.collection('completed_homeworks').where('groupId', '==', groupDoc.id).get();
            const submittedIds = new Set();
            completedSnap.forEach(d => submittedIds.add(d.data().assignmentId));

            const pendingHws = [];
            activeHws.forEach(d => {
                if (!submittedIds.has(d.id)) {
                    pendingHws.push(d.data().title || 'Без назви');
                }
            });

            const hwBlock = pendingHws.length > 0
                ? `\n\n📚 *Незавершені ДЗ:*\n${pendingHws.slice(0, 3).map(h => `  • ${h}`).join('\n')}`
                : '\n\n✅ Усі домашні завдання виконано!';

            const promises = [];
            usersSnap.forEach(doc => {
                const data = doc.data();
                if (data.tgChatId) {
                    promises.push(
                        tgSend(data.tgChatId,
                            `🌙 *Нагадування на завтра*\n\n` +
                            `📅 Завтра заняття о *${lessonTime}*\n` +
                            `📂 Група: *${groupData.groupName}*` +
                            hwBlock +
                            `\n\n👉 [Відкрити кабінет](${CABINET_URL})`,
                            { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: MAIN_KEYBOARD }
                        ).catch(() => {})
                    );
                }
            });
            await Promise.all(promises);
        }
    } catch (e) {
        console.error('[EveningReminder Error]', e.message);
    }
}

async function sendScheduleChangeNotification(groupId, dateStr, oldTime, newTime, changeType) {
    try {
        const groupDoc = await db.collection('groups').doc(groupId).get();
        if (!groupDoc.exists) return;
        const groupData = groupDoc.data();
        const members = groupData.members || [];
        if (members.length === 0) return;

        const formatUkrDate = (dStr) => {
            const months = ['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'];
            const [y, m, d] = dStr.split('-');
            return `${parseInt(d)} ${months[parseInt(m) - 1]} ${y}`;
        };

        let msgText = '';
        if (changeType === 'cancelled') {
            msgText = `❌ *Заняття скасовано*\n\n📅 Дата: *${formatUkrDate(dateStr)}*\n📂 Група: *${groupData.groupName}*`;
        } else if (changeType === 'rescheduled') {
            msgText = `🔄 *Заняття перенесено*\n\n📅 Стара дата: *${formatUkrDate(dateStr)}*\n🆕 Нова дата: *${formatUkrDate(newTime)}*\n📂 Група: *${groupData.groupName}*`;
        } else if (changeType === 'time_changed') {
            msgText = `⏰ *Змінено час заняття*\n\n📅 Дата: *${formatUkrDate(dateStr)}*\n🕐 Новий час: *${newTime}*\n📂 Група: *${groupData.groupName}*`;
        } else {
            msgText = `📅 *Оновлення розкладу*\n\n📅 Дата: *${formatUkrDate(dateStr)}*\n📂 Група: *${groupData.groupName}*`;
        }

        for (let i = 0; i < members.length; i += 10) {
            const chunk = members.slice(i, i + 10);
            const usersSnap = await db.collection('users')
                .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
                .get();

            const promises = [];
            usersSnap.forEach(doc => {
                const data = doc.data();
                if (data.tgChatId) {
                    promises.push(
                        tgSend(data.tgChatId, msgText, {
                            parse_mode: 'Markdown',
                            reply_markup: MAIN_KEYBOARD
                        }).catch(() => {})
                    );
                }
            });
            await Promise.all(promises);
        }
    } catch (e) {
        console.error('[ScheduleNotify Error]', e.message);
    }
}

module.exports = async function handler(req, res) {
    if (req.method === 'GET') {
        const action = req.query?.action;
        if (action === 'evening_reminders') {
            await sendEveningReminders();
            res.status(200).send('OK');
            return;
        }
        res.status(200).send('OK');
        return;
    }

    if (req.method !== 'POST') {
        res.status(200).send('OK');
        return;
    }

    const action = req.query?.action || req.body?.action;
    if (action === 'schedule_change') {
        const { groupId, dateStr, oldTime, newTime, changeType } = req.body;
        if (groupId && dateStr) {
            await sendScheduleChangeNotification(groupId, dateStr, oldTime, newTime, changeType);
        }
        res.status(200).send('OK');
        return;
    }

    let update;
    try {
        update = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (e) {
        console.error('[Parse Error]', e.message);
        res.status(200).send('OK');
        return;
    }

    try {
        await handleUpdate(update);
    } catch (e) {
        console.error('[Handler Error]', e.message, e.stack);
        const chatId = update?.message?.chat?.id || update?.callback_query?.message?.chat?.id;
        if (chatId) {
            try { await tgSend(chatId, '⚠️ Сталася помилка. Спробуй ще раз.', { reply_markup: MAIN_KEYBOARD }); } catch (_) {}
        }
    }

    res.status(200).send('OK');
};

module.exports.sendScheduleChangeNotification = sendScheduleChangeNotification;