import { db } from '../../../firebase';
import type { DocumentData, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { v4 as uuidv4 } from 'uuid';
import { generateCoachResponse, generateSummary, streamCoachResponse } from './geminiService';
import { UserInfo } from './userInfoService';
import { logger } from '../../../utils/logger';
import { getWebSocketService } from '../../../services/websocketService';

const COACH_REFUSAL_MESSAGE = 'Bu istegi burada dogrudan yerine getiremiyorum, alternatif bir yol onerebilirim.';

const shouldRefuseCoachRequest = (message: string) => {
  const lower = (message || '').toLowerCase();
  if (!lower) {
    return false;
  }

  const disallowedFileTypes = ['pdf', 'doc', 'docx', 'word', 'ppt', 'pptx', 'powerpoint'];
  if (disallowedFileTypes.some(type => lower.includes(type))) {
    return true;
  }

  const createVerbs = ['oluştur', 'üret', 'generate', 'create', 'yap', 'tasarla', 'çiz', 'yaz'];
  const targets = ['görsel', 'resim', 'image', 'logo', 'video', 'kod', 'code', 'script', 'website', 'web sitesi', 'uygulama', 'app'];
  const hasCreateVerb = createVerbs.some(verb => lower.includes(verb));
  const hasTarget = targets.some(target => lower.includes(target));
  return hasCreateVerb && hasTarget;
};

export const createChatSession = async (userId: string) => {
  const now = new Date().toISOString();
  const session = {
    user_id: userId,
    status: 'open',
    created_at: now,
    updated_at: now
  };
  const ref = await db.collection('chat_sessions').add(session);
  return { id: ref.id, ...session };
};

export const createChildChatSession = async (params: {
  userId: string;
  childId: string;
  childName: string;
}) => {
  const now = new Date().toISOString();
  const session = {
    user_id: params.userId,
    child_id: params.childId,
    child_name: params.childName,
    status: 'open',
    created_at: now,
    updated_at: now,
  };
  const ref = await db.collection('chat_sessions').add(session);
  logger.info(
    { userId: params.userId, childId: params.childId, childName: params.childName, sessionId: ref.id },
    'Child chat session created',
  );
  return { id: ref.id, ...session };
};

export const listChatSessions = async (userId: string) => {
  const snapshot = await db
    .collection('chat_sessions')
    .where('user_id', '==', userId)
    .orderBy('updated_at', 'desc')
    .get();
  return snapshot.docs.map((doc: QueryDocumentSnapshot<DocumentData>) => ({ id: doc.id, ...doc.data() }));
};

export const listChatMessages = async (sessionId: string) => {
  const snapshot = await db
    .collection('chat_messages')
    .where('session_id', '==', sessionId)
    .orderBy('created_at', 'asc')
    .get();
  return snapshot.docs.map((doc: QueryDocumentSnapshot<DocumentData>) => ({ id: doc.id, ...doc.data() }));
};

const getChatMemorySummary = async (userId: string) => {
  const snapshot = await db
    .collection('chat_memory_summaries')
    .where('user_id', '==', userId)
    .limit(1)
    .get();
  if (snapshot.empty) {
    return null;
  }
  const doc = snapshot.docs[0];
  return { id: doc.id, ...(doc.data() as any) };
};

const maybeUpdateSummary = async (userId: string, sessionId: string) => {
  const messagesSnapshot = await db
    .collection('chat_messages')
    .where('session_id', '==', sessionId)
    .orderBy('created_at', 'desc')
    .limit(50)
    .get();

  if (messagesSnapshot.size < 50) {
    return;
  }

  const messages = messagesSnapshot.docs.map((doc: QueryDocumentSnapshot<DocumentData>) => doc.data() as any).reverse();
  const summaryInput = messages
    .map((msg: { role?: string; content?: string }) => `${msg.role === 'assistant' ? 'Koç' : 'Kullanıcı'}: ${msg.content ?? ''}`)
    .join('\n');

  const summaryText = await generateSummary(summaryInput);
  if (!summaryText) {
    return;
  }

  const existingSummary = await getChatMemorySummary(userId);
  const payload = {
    user_id: userId,
    summary: summaryText,
    last_message_at: new Date().toISOString()
  };

  if (existingSummary) {
    await db.collection('chat_memory_summaries').doc(existingSummary.id).set(payload, { merge: true });
  } else {
    await db.collection('chat_memory_summaries').add(payload);
  }
};

const toText = (value: unknown, fallback = '-') => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
};

const buildToneGuideTr = (tone: string) => {
  switch (tone) {
    case 'formal':
      return 'Profesyonel, net ve yapılandırılmış bir üslup kullan.';
    case 'friendly':
      return 'Sıcak, destekleyici ve aile dostu bir üslup kullan.';
    case 'concise':
      return 'Gereksiz uzatmadan, kısa ve net cümlelerle yanıt ver.';
    case 'inspiring':
      return 'Motive edici ve umut veren bir anlatım kullan.';
    case 'joyful':
      return 'Neşeli, pozitif ve enerji veren bir ton kullan.';
    case 'listener':
      return 'Empatik, nazik ve iyi dinleyen bir rehber gibi konuş.';
    default:
      return 'Neşeli, uyumlu ve ebeveyni güçlendiren bir üslup kullan.';
  }
};

const buildLengthGuideTr = (length: string) => {
  switch (length) {
    case 'short':
      return 'Yanıtı kısa ve doğrudan ver.';
    case 'detailed':
      return 'Yanıtı detaylı, adım adım ve açıklayıcı ver.';
    default:
      return 'Yanıtı dengeli uzunlukta ver.';
  }
};

const buildEmojiGuideTr = (emojiStyle: string) => {
  switch (emojiStyle) {
    case 'none':
      return 'Emoji kullanma.';
    case 'rich':
      return 'Uygun yerlerde bol ve sıcak emoji kullan.';
    default:
      return 'Dengeli ve ölçülü emoji kullan.';
  }
};

const buildContext = async (
  user: UserInfo,
  memorySummary: any,
  recentMessages: any[],
  currentMessage: string,
  contextTags?: Record<string, unknown> | null,
  imageMeta?: { mimeType?: string } | null,
) => {

  const userContext = `Kullanıcı: ${user.name || 'Bilinmiyor'}, Hedef: ${user.goal || 'maintain'}, Boy/Kilo: ${user.height_cm || '-'} / ${user.current_weight_kg || '-'}`;
  const memory = `Hafıza Özeti: ${memorySummary?.summary || 'Yeni kullanıcı, sıcak karşıla.'}`;
  const childProfile = (contextTags?.childProfile as any) || null;
  const childContext = childProfile
    ? `Secili Bebek: ${childProfile.name || '-'}, Cinsiyet: ${childProfile.gender || '-'}, Dogum Tarihi: ${childProfile.birthDate || '-'}`
    : 'Secili Bebek: belirtilmedi';
  const personalization = (contextTags?.chatPersonalization as any) || null;
  const toneContext = personalization
    ? `Sohbet Ayari: tone=${personalization.tone || '-'}, mood=${personalization.mood || '-'}, cevap_uzunlugu=${personalization.responseLength || '-'}, emoji=${personalization.emojiStyle || '-'}`
    : 'Sohbet Ayari: varsayilan';
  const tone = toText(personalization?.tone, 'default');
  const mood = toText(personalization?.mood, 'cheerful');
  const responseLength = toText(personalization?.responseLength, 'balanced');
  const emojiStyle = toText(personalization?.emojiStyle, 'some');
  const hasImage = Boolean(imageMeta?.mimeType);
  const history = recentMessages
    .map((msg: { role?: string; content?: string }) => `${msg.role === 'assistant' ? 'Koç' : 'Kullanıcı'}: ${msg.content ?? ''}`)
    .join('\n');

  const babyInstruction = childProfile
    ? `Seçili bebek bilgisi: İsim=${toText(childProfile.name, 'Belirtilmedi')}, Cinsiyet=${toText(
        childProfile.gender,
        'Belirtilmedi',
      )}, Doğum Tarihi=${toText(childProfile.birthDate, 'Belirtilmedi')}. Yanıtını bu bebeğe göre kişiselleştir.`
    : 'Seçili bebek yok. Ebeveyni genel ve güvenli şekilde yönlendir.';

  return [
    'ROL:',
    "Sen 'Bebek AI' adında, ebeveynlere destek veren uzman bir bebek gelişimi ve ebeveynlik asistanısın.",
    '',
    'ZORUNLU DİL KURALI:',
    '- Tüm yanıtlar sadece Türkçe olmalı.',
    '- İngilizce terim gerekiyorsa kısa Türkçe açıklamasıyla birlikte ver.',
    '',
    'KİŞİSELLEŞTİRME TALİMATLARI:',
    `- Ton: ${buildToneGuideTr(tone)}`,
    `- Ruh Hali (Mood): ${mood} (yanıta bu havayı doğal şekilde yansıt).`,
    `- Uzunluk: ${buildLengthGuideTr(responseLength)}`,
    `- Emoji: ${buildEmojiGuideTr(emojiStyle)}`,
    '',
    'BEBEK BAĞLAMI:',
    `- ${babyInstruction}`,
    '',
    'GÜVENLİK KURALLARI:',
    '- Önce güvenlik: Acil risk olabilecek belirtilerde nazikçe doktora/acile yönlendir.',
    '- Spesifik ilaç dozu veya tıbbi reçete verme.',
    '- Kesin tanı koyma; bilgilendirici ve yönlendirici kal.',
    '',
    'GÖRSEL KURALI:',
    hasImage
      ? '- Kullanıcı görsel paylaştı. Görselde gördüğün ifadeyi/bağlamı Türkçe ve nazik biçimde yorumla; kesin tıbbi tanı koyma.'
      : '- Bu istekte görsel yok.',
    '',
    'EK BAĞLAM:',
    `- ${userContext}`,
    `- ${childContext}`,
    `- ${toneContext}`,
    `- ${memory}`,
    '',
    'SON KONUŞMALAR:',
    history || '-',
    '',
    `YENİ MESAJ: ${currentMessage}`,
  ].join('\n');
};

const prepareChatContext = async (params: {
  user: UserInfo;
  sessionId?: string;
  message: string;
  contextTags?: Record<string, unknown>;
  imageMeta?: { mimeType?: string } | null;
}) => {
  const { user, sessionId, message, contextTags, imageMeta } = params;
  const session = sessionId ? { id: sessionId } : await createChatSession(user.id);

  const now = new Date().toISOString();
  const userMessageId = uuidv4();
  await db.collection('chat_messages').doc(userMessageId).set({
    id: userMessageId,
    session_id: session.id,
    role: 'user',
    content: message,
    metadata: contextTags || null,
    image: imageMeta || null,
    created_at: now
  });

  const recentMessagesSnapshot = await db
    .collection('chat_messages')
    .where('session_id', '==', session.id)
    .orderBy('created_at', 'desc')
    .limit(20)
    .get();

  const recentMessages = recentMessagesSnapshot.docs.map((doc: QueryDocumentSnapshot<DocumentData>) => doc.data() as any).reverse();
  const memorySummary = await getChatMemorySummary(user.id);

  const context = await buildContext(user, memorySummary, recentMessages, message, contextTags || null, imageMeta);
  logger.info(
    {
      userId: user.id,
      sessionId: session.id,
      hasChildProfile: Boolean((contextTags as any)?.childProfile),
      hasChatPersonalization: Boolean((contextTags as any)?.chatPersonalization),
      step: 'chat_context_built',
    },
    'Chat context built with personalization',
  );
  const history = recentMessages.map((item: { role?: string; content?: string }) => ({ role: item.role, content: item.content }));

  return {
    session,
    userMessageId,
    recentMessages,
    memorySummary,
    context,
    history,
  };
};

export const handleChatMessage = async (params: {
  user: UserInfo;
  sessionId?: string;
  message: string;
  contextTags?: Record<string, unknown>;
  imagePayload?: { data: string; mimeType: string } | null;
}) => {
  const { user, sessionId, message, contextTags, imagePayload } = params;
  const imageMeta = imagePayload ? { mimeType: imagePayload.mimeType } : null;
  const { session, context, history } = await prepareChatContext({
    user,
    sessionId,
    message,
    contextTags,
    imageMeta
  });

  logger.info({ userId: user.id, sessionId: session.id }, 'Bebek chat context assembled');
  const replyText = shouldRefuseCoachRequest(message)
    ? COACH_REFUSAL_MESSAGE
    : await generateCoachResponse(context, history, imagePayload || undefined);

  const assistantMessageId = uuidv4();
  await db.collection('chat_messages').doc(assistantMessageId).set({
    id: assistantMessageId,
    session_id: session.id,
    role: 'assistant',
    content: replyText,
    metadata: contextTags || null,
    created_at: new Date().toISOString()
  });

  await db.collection('chat_sessions').doc(session.id).set(
    {
      updated_at: new Date().toISOString()
    },
    { merge: true }
  );

  await maybeUpdateSummary(user.id, session.id);

  return {
    reply: replyText,
    sessionId: session.id
  };
};

export const handleChatMessageStream = async (params: {
  user: UserInfo;
  sessionId?: string;
  message: string;
  contextTags?: Record<string, unknown>;
  imagePayload?: { data: string; mimeType: string } | null;
}) => {
  const { user, sessionId, message, contextTags, imagePayload } = params;
  const imageMeta = imagePayload ? { mimeType: imagePayload.mimeType } : null;
  const { session, context, history } = await prepareChatContext({
    user,
    sessionId,
    message,
    contextTags,
    imageMeta,
  });

  const assistantMessageId = uuidv4();
  const websocket = getWebSocketService();

  const sendChunk = (payload: { delta?: string; content?: string; isFinal?: boolean; error?: string }) => {
    websocket?.sendToUser(user.id, 'chat:stream', {
      chatId: session.id,
      messageId: assistantMessageId,
      ...payload,
    });
  };

  const finalizeAndPersist = async (content: string) => {
    await db.collection('chat_messages').doc(assistantMessageId).set({
      id: assistantMessageId,
      session_id: session.id,
      role: 'assistant',
      content,
      metadata: contextTags || null,
      created_at: new Date().toISOString()
    });

    await db.collection('chat_sessions').doc(session.id).set(
      {
        updated_at: new Date().toISOString()
      },
      { merge: true }
    );

    await maybeUpdateSummary(user.id, session.id);
  };

  const runStream = async () => {
    if (shouldRefuseCoachRequest(message)) {
      sendChunk({ delta: COACH_REFUSAL_MESSAGE, isFinal: true, content: COACH_REFUSAL_MESSAGE });
      await finalizeAndPersist(COACH_REFUSAL_MESSAGE);
      return;
    }

    let sentAny = false;
    let latestText = '';

    try {
      latestText = await streamCoachResponse({
        context,
        history,
        image: imagePayload || undefined,
        onDelta: (delta, fullText) => {
          sentAny = true;
          latestText = fullText;
          sendChunk({ delta });
        },
      });

      const finalText = latestText || '';
      sendChunk({ content: finalText, isFinal: true });
      await finalizeAndPersist(finalText);
    } catch (error) {
      logger.error({ err: error, userId: user.id, sessionId: session.id }, 'Gemini streaming failed');
      if (!sentAny) {
        const fallback = await generateCoachResponse(context, history, imagePayload || undefined);
        sendChunk({ content: fallback, delta: fallback, isFinal: true });
        await finalizeAndPersist(fallback);
      } else {
        sendChunk({ error: 'Streaming failed', isFinal: true, content: latestText || '' });
        if (latestText) {
          await finalizeAndPersist(latestText);
        }
      }
    }
  };

  return {
    sessionId: session.id,
    messageId: assistantMessageId,
    run: runStream,
  };
};
