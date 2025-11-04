/**
 * Cloud Functions for İmtahan+ app
 * Отправляет push-уведомления пользователям через FCM
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();


exports.sendPushNotification = functions.firestore
    .document('push_notifications_queue/{notificationId}')
    .onCreate(async (snap, context) => {
      const notificationData = snap.data();
      const notificationId = context.params.notificationId;

      // Проверяем, не отправлено ли уже уведомление
      if (notificationData.sent === true) {
        console.log(`Notification ${notificationId} already sent, skipping`);
        return null;
      }

      const { user_id, fcm_token, title, body, data } = notificationData;

      if (!fcm_token) {
        console.error(`No FCM token for user ${user_id}`);
        // Помечаем как отправленное, чтобы не повторять
        await snap.ref.update({
          sent: true,
          error: 'No FCM token',
          sent_at: admin.firestore.FieldValue.serverTimestamp(),
        });
        return null;
      }

      try {
        // Создаем сообщение для FCM
        const message = {
          notification: {
            title: title || 'İmtahan+',
            body: body || '',
          },
          data: {
            ...data,
            notificationId: notificationId,
            userId: user_id,
            timestamp: Date.now().toString(),
          },
          token: fcm_token,
          android: {
            priority: 'high',
            notification: {
              sound: 'default',
              channelId: 'imtahan_plus_notifications',
              clickAction: 'FLUTTER_NOTIFICATION_CLICK',
            },
          },
          apns: {
            payload: {
              aps: {
                sound: 'default',
                badge: 1,
              },
            },
          },
        };

        // Отправляем уведомление через FCM
        const response = await admin.messaging().send(message);
        console.log(`Successfully sent message to ${user_id}:`, response);

        // Помечаем уведомление как отправленное
        await snap.ref.update({
          sent: true,
          sent_at: admin.firestore.FieldValue.serverTimestamp(),
          fcm_response: response,
        });

        return null;
      } catch (error) {
        console.error(`Error sending notification to ${user_id}:`, error);

        // Помечаем уведомление с ошибкой
        await snap.ref.update({
          sent: true,
          error: error.message,
          sent_at: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Если токен недействителен, удаляем его из профиля пользователя
        if (error.code === 'messaging/invalid-registration-token' ||
            error.code === 'messaging/registration-token-not-registered') {
          console.log(`Invalid token for user ${user_id}, removing from profile`);
          try {
            await admin.firestore()
                .collection('profiles')
                .doc(user_id)
                .update({
                  fcm_token: admin.firestore.FieldValue.delete(),
                });
          } catch (updateError) {
            console.error(`Error removing invalid token:`, updateError);
          }
        }

        return null;
      }
    });

/**
 * Очистка старых записей из очереди уведомлений
 * Запускается каждый день в 2:00 UTC
 */
exports.cleanupNotificationQueue = functions.pubsub
    .schedule('0 2 * * *')
    .timeZone('UTC')
    .onRun(async (context) => {
      const oneDayAgo = admin.firestore.Timestamp.fromDate(
          new Date(Date.now() - 24 * 60 * 60 * 1000),
      );

      const oldNotifications = await admin.firestore()
          .collection('push_notifications_queue')
          .where('sent', '==', true)
          .where('sent_at', '<', oneDayAgo)
          .limit(500)
          .get();

      const batch = admin.firestore().batch();
      let deletedCount = 0;

      oldNotifications.forEach((doc) => {
        batch.delete(doc.ref);
        deletedCount++;
      });

      if (deletedCount > 0) {
        await batch.commit();
        console.log(`Cleaned up ${deletedCount} old notifications`);
      }

      return null;
    });

/**
 * Автоматическая очистка истекших постов (30 дней)
 * Запускается каждый день в 3:00 по времени Баку (UTC+4)
 * Удаляет вопросы и их ответы, у которых истек срок действия (expires_at)
 */
exports.cleanupExpiredPosts = functions.pubsub
    .schedule('0 3 * * *') // Каждый день в 3:00 UTC (7:00 по Баку)
    .timeZone('UTC')
    .onRun(async (context) => {
      const db = admin.firestore();
      const now = admin.firestore.Timestamp.now();
      
      console.log('Начинаем очистку истекших постов...');
      
      // Находим истекшие вопросы (используем ограничение для батча)
      const expiredQuestions = await db.collection('questions')
          .where('expires_at', '<', now)
          .limit(500) // Ограничиваем количество для батча Firestore (макс 500)
          .get();
      
      if (expiredQuestions.empty) {
        console.log('Нет истекших постов для удаления');
        return null;
      }
      
      console.log(`Найдено ${expiredQuestions.size} истекших постов для удаления`);
      
      let batch = db.batch();
      let batchOperations = 0;
      let deletedCount = 0;
      let totalAnswersDeleted = 0;
      const MAX_BATCH_SIZE = 500; // Максимальное количество операций в батче
      
      // Удаляем истекшие вопросы и их ответы
      for (const doc of expiredQuestions.docs) {
        try {
          // Удаляем все ответы на вопрос
          const answersSnapshot = await doc.ref.collection('answers').get();
          
          for (const answerDoc of answersSnapshot.docs) {
            batch.delete(answerDoc.ref);
            batchOperations++;
            totalAnswersDeleted++;
            
            // Если достигли лимита батча, коммитим и создаем новый
            if (batchOperations >= MAX_BATCH_SIZE) {
              await batch.commit();
              console.log(`Удалено ${deletedCount} вопросов и ${totalAnswersDeleted} ответов...`);
              batch = db.batch(); // Создаем новый батч
              batchOperations = 0;
            }
          }
          
          // Удаляем сам вопрос
          batch.delete(doc.ref);
          batchOperations++;
          deletedCount++;
          
          // Если достигли лимита батча, коммитим и создаем новый
          if (batchOperations >= MAX_BATCH_SIZE) {
            await batch.commit();
            console.log(`Удалено ${deletedCount} вопросов и ${totalAnswersDeleted} ответов...`);
            batch = db.batch(); // Создаем новый батч
            batchOperations = 0;
          }
        } catch (error) {
          console.error(`Ошибка при удалении вопроса ${doc.id}:`, error);
          // Продолжаем удаление других постов
        }
      }
      
      // Коммитим последний батч, если есть операции
      if (batchOperations > 0) {
        await batch.commit();
        console.log(`✅ Очистка завершена: удалено ${deletedCount} вопросов и ${totalAnswersDeleted} ответов`);
      } else if (deletedCount > 0) {
        console.log(`✅ Очистка завершена: удалено ${deletedCount} вопросов и ${totalAnswersDeleted} ответов`);
      }
      
      return null;
    });

/**
 * HTTP функция для ручной отправки тестового уведомления
 * Использование: POST /sendTestNotification
 * Body: { "userId": "user_id", "title": "Test", "body": "Message" }
 */
exports.sendTestNotification = functions.https.onRequest(async (req, res) => {
  // Разрешаем CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  try {
    const { userId, title, body, data } = req.body;

    if (!userId) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }

    // Получаем FCM токен пользователя
    const userDoc = await admin.firestore()
        .collection('profiles')
        .doc(userId)
        .get();

    if (!userDoc.exists) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const fcmToken = userDoc.data()?.fcm_token;

    if (!fcmToken) {
      res.status(400).json({ error: 'User has no FCM token' });
      return;
    }

    // Создаем запись в очереди для отправки
    await admin.firestore().collection('push_notifications_queue').add({
      user_id: userId,
      fcm_token: fcmToken,
      title: title || 'Test Notification',
      body: body || 'This is a test notification',
      data: data || {},
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      sent: false,
    });

    res.status(200).json({
      success: true,
      message: 'Notification queued for sending',
    });
  } catch (error) {
    console.error('Error in sendTestNotification:', error);
    res.status(500).json({ error: error.message });
  }
});

