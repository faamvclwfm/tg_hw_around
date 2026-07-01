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

const KYIV_TZ = 'Europe/Kyiv';

// Повертає поточну годину за Києвом (0-23), незалежно від того, де фізично
// виконується сервер (Vercel завжди працює в UTC) і незалежно від переходу
// на літній/зимовий час — Intl сам підтягує правильний офсет для Europe/Kyiv.
function getKyivHour(date = new Date()) {
    const hourStr = new Intl.DateTimeFormat('en-GB', {
        timeZone: KYIV_TZ,
        hour: '2-digit',
        hourCycle: 'h23'
    }).format(date);
    return parseInt(hourStr, 10);
}

// Формат YYYY-MM-DD за Києвом (en-CA форматує саме так)
function formatInKyiv(date) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: KYIV_TZ }).format(date);
}

function getTomorrowDateStr() {
    return formatInKyiv(new Date(Date.now() + 24 * 60 * 60 * 1000));
}

function getDowFromDateStr(dateStr) {
    // Парсимо як UTC-опівніч, щоб день тижня не з'їжджав через таймзону сервера
    let dow = new Date(dateStr + 'T00:00:00Z').getUTCDay();
    if (dow === 0) dow = 7;
    return dow;
}

function getTomorrowDow() {
    return getDowFromDateStr(getTomorrowDateStr());
}

function formatDate(dateStr) {
    const months = ['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'];
    const [y, m, d] = dateStr.split('-');
    return `${parseInt(d)} ${months[parseInt(m) - 1]}`;
}

async function getActiveHomeworks(groupId, userId) {
    const [assignSnap, completedSnap] = await Promise.all([
        db.collection('assignments').where('groupId', '==', groupId).get(),
        db.collection('completed_homeworks').where('groupId', '==', groupId).where('userId', '==', userId).get()
    ]);

    if (assignSnap.empty) return [];

    const submittedIds = new Set();
    completedSnap.forEach(d => submittedIds.add(d.data().assignmentId));

    const active = [];
    assignSnap.forEach(d => {
        if (!submittedIds.has(d.id)) active.push({ id: d.id, ...d.data() });
    });

    active.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    return active;
}


async function sendSubscriptionReminders(usersMap) {
    let sentCount = 0;

    for (const uid of Object.keys(usersMap)) {
        const user = usersMap[uid];
        if (!user || !user.tgChatId) continue;

        const sub = user.subscription;
        if (!sub) continue;

        const paid = Number(sub.paid || 0);
        const attended = Number(sub.attended || 0);
        const left = paid - attended;

        if (left !== 1) continue;
        if (sub.lowBalanceNotified) continue;

        const price = Number(sub.pricePerLesson || 0);
        const sum = price * paid;
        const nextPaymentStr = sub.nextPayment ? formatDate(sub.nextPayment) : 'не вказано';
        const sumLine = price > 0 ? `\n💰 Сума до оплати: *${sum} грн*` : '';

        const text =
            `⚠️ *Абонемент майже закінчився!*\n\n` +
            `У тебе залишилось *1 заняття* з оплаченого абонементу.` +
            sumLine +
            `\n📅 Оплата до: *${nextPaymentStr}*\n\n` +
            `Зверніться до вчителя, щоб поповнити абонемент 🙌`;

        try {
            await tgSend(user.tgChatId, text, { parse_mode: 'Markdown', disable_web_page_preview: true });
            await db.collection('users').doc(uid).update({ 'subscription.lowBalanceNotified': true });
            sentCount++;
        } catch (e) {
            console.error(`[SubReminder] Failed for ${uid}:`, e.message);
        }
    }

    console.log(`[SubReminder] Sent ${sentCount} subscription reminders.`);
}

async function sendReminders() {
    const tomorrowStr = getTomorrowDateStr();
    const tomorrowDow = getTomorrowDow();

    console.log(`[Reminders] Running for tomorrow: ${tomorrowStr} (dow=${tomorrowDow})`);

    const groupsSnap = await db.collection('groups').get();
    if (groupsSnap.empty) return;

    // Збираємо всіх учнів з усіх груп + перевіряємо чи є заняття завтра
    const remindersToSend = [];

    groupsSnap.forEach(groupDoc => {
        const groupId = groupDoc.id;
        const data = groupDoc.data();
        const schedule = data.schedule || {};
        const recurring = schedule.recurring || [];
        const exceptions = schedule.exceptions || {};
        const members = data.members || [];

        if (members.length === 0) return;

        // Перевіряємо чи є заняття завтра
        let tomorrowLessons = [];
        let hasLessonTomorrow = false;
        let lessonTimeStr = '';

        const exception = exceptions[tomorrowStr];
        if (exception) {
            if (exception.list && Array.isArray(exception.list)) {
                tomorrowLessons = exception.list.filter(l => l.status !== 'cancelled' && l.status !== 'rescheduled');
            } else if (exception.status && exception.status !== 'cancelled' && exception.status !== 'rescheduled' && exception.status !== 'none') {
                tomorrowLessons = [{ time: exception.time || '—', status: exception.status }];
            }
        } else {
            const rec = recurring.find(r => r.day === tomorrowDow);
            if (rec) {
                tomorrowLessons = [{ time: rec.time || '—', status: 'scheduled' }];
            }
        }

        if (tomorrowLessons.length > 0) {
            hasLessonTomorrow = true;
            lessonTimeStr = tomorrowLessons.map(l => l.time).join(', ');
        }

        members.forEach(userId => {
            remindersToSend.push({ groupId, userId, tomorrowStr, hasLessonTomorrow, lessonTimeStr });
        });
    });

    if (remindersToSend.length === 0) {
        console.log('[Reminders] No members found.');
        return;
    }

    // Завантажуємо дані юзерів батчами
    const uniqueUserIds = [...new Set(remindersToSend.map(r => r.userId))];
    const usersMap = {};
    const batchSize = 10;
    for (let i = 0; i < uniqueUserIds.length; i += batchSize) {
        const chunk = uniqueUserIds.slice(i, i + batchSize);
        const snap = await db.collection('users')
            .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
            .get();
        snap.forEach(doc => {
            usersMap[doc.id] = { uid: doc.id, ...doc.data() };
        });
    }

    // Нагадування про абонемент перевіряємо для всіх учнів, кого щойно завантажили,
    // незалежно від того, є в них заняття завтра чи ні.
    await sendSubscriptionReminders(usersMap).catch(e => console.error('[SubReminder] failed:', e.message));

    const sends = [];

    for (const reminder of remindersToSend) {
        const user = usersMap[reminder.userId];
        if (!user || !user.tgChatId) continue;

        const activeHws = await getActiveHomeworks(reminder.groupId, reminder.userId).catch(() => []);

        // Відправляємо нагадування якщо: є заняття завтра АБО є невиконані ДЗ
        if (!reminder.hasLessonTomorrow && activeHws.length === 0) continue;

        let text = '';

        if (reminder.hasLessonTomorrow && activeHws.length > 0) {
            // Є і заняття і ДЗ
            const hwLines = activeHws.slice(0, 3).map((hw, i) => {
                const count = (hw.requiredTests || []).length;
                return `  ${i + 1}. 📌 *${hw.title || 'Без назви'}* (${count} тест${count === 1 ? '' : 'ів'})`;
            });
            text =
                `🔔 *Нагадування*\n\n` +
                `📅 Завтра заняття о *${reminder.lessonTimeStr}*\n\n` +
                `📚 *Невиконані домашні завдання:*\n${hwLines.join('\n')}` +
                (activeHws.length > 3 ? `\n  ...і ще ${activeHws.length - 3}` : '') +
                `\n\n👉 [Виконати в кабінеті](${CABINET_URL})`;
        } else if (reminder.hasLessonTomorrow && activeHws.length === 0) {
            // Є заняття, ДЗ немає
            text =
                `🔔 *Нагадування*\n\n` +
                `📅 Завтра заняття о *${reminder.lessonTimeStr}*\n\n` +
                `✅ Всі домашні завдання виконано — молодець!`;
        } else {
            // Немає заняття, але є невиконані ДЗ
            const hwLines = activeHws.slice(0, 3).map((hw, i) => {
                const count = (hw.requiredTests || []).length;
                return `  ${i + 1}. 📌 *${hw.title || 'Без назви'}* (${count} тест${count === 1 ? '' : 'ів'})`;
            });
            text =
                `📚 *Нагадування про домашні завдання*\n\n` +
                `У тебе є невиконані ДЗ:\n${hwLines.join('\n')}` +
                (activeHws.length > 3 ? `\n  ...і ще ${activeHws.length - 3}` : '') +
                `\n\n👉 [Виконати в кабінеті](${CABINET_URL})`;
        }

        sends.push(
            tgSend(user.tgChatId, text, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            }).catch(e => console.error(`[TG] Failed to send to ${user.tgChatId}:`, e.message))
        );
    }

    await Promise.allSettled(sends);
    console.log(`[Reminders] Sent ${sends.length} reminders.`);
}

// О котрій за Києвом реально надсилати нагадування
const TARGET_KYIV_HOUR = 17;

module.exports = async function handler(req, res) {
    const secret = req.query?.secret || req.headers['x-cron-secret'];
    if (secret !== process.env.CRON_SECRET) {
        res.status(401).send('Unauthorized');
        return;
    }

    const force = req.query?.force === '1';
    const kyivHour = getKyivHour();

    if (!force && kyivHour !== TARGET_KYIV_HOUR) {
        res.status(200).send(`Skipped: current Kyiv hour is ${kyivHour}, waiting for ${TARGET_KYIV_HOUR}:00`);
        return;
    }

    try {
        await sendReminders();
        res.status(200).send('OK');
    } catch (e) {
        console.error('[Cron Error]', e.message, e.stack);
        res.status(500).send('Error');
    }
};