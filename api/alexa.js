const Alexa = require('ask-sdk-core');
const admin = require('firebase-admin');
const express = require('express');
const { ExpressAdapter } = require('ask-sdk-express-adapter');
const getRawBody = require('raw-body');

// ============================================================
// FIREBASE INITIALIZATION
// ============================================================

async function initFirebase() {
  if (admin.apps.length > 0) return;
  
  try {
    let serviceAccount;

    if (process.env.FIREBASE_SA_B64) {
      console.log('Using FIREBASE_SA_B64 for Firebase initialization');
      const serviceAccountJson = Buffer.from(process.env.FIREBASE_SA_B64, 'base64').toString('utf8');
      serviceAccount = JSON.parse(serviceAccountJson);
    }
    else if (process.env.FIREBASE_PRIVATE_KEY) {
      console.log('Using individual env vars for Firebase initialization');
      serviceAccount = {
        type: "service_account",
        project_id: process.env.FIREBASE_PROJECT_ID,
        private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
        private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        client_id: process.env.FIREBASE_CLIENT_ID,
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
        client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL
      };
    }
    else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      console.log('Using FIREBASE_SERVICE_ACCOUNT JSON for Firebase initialization');
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    }
    else {
      throw new Error('No Firebase service account configuration found in environment variables.');
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: process.env.FIREBASE_PROJECT_ID
    });
    console.log('Firebase initialized successfully');
  } catch (error) {
    console.error('Firebase initialization failed:', error);
    throw error;
  }
}

let firebaseInitialized = false;
async function ensureFirebaseInitialized() {
  if (!firebaseInitialized) {
    try {
      await initFirebase();
      firebaseInitialized = true;
    } catch (error) {
      console.error('Initial Firebase init failed:', error);
      throw error;
    }
  }
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function getFormattedDate(date = new Date()) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getLocalDate() {
  return new Date();
}

function generateSessionCode(sessionName) {
  const base = sessionName.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 8);
  const random = Math.random().toString(36).substring(2, 6);
  return base + random;
}

function formatAlexaDate(dateStr) {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
  } catch (error) {
    return dateStr;
  }
}

function getYearMonthFromDate(dateStr = null) {
  const date = dateStr ? new Date(dateStr) : new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function getAccessToken(handlerInput) {
  try {
    return handlerInput.requestEnvelope.context.System.user.accessToken;
  } catch (error) {
    return null;
  }
}

function requireAccountLinking(handlerInput) {
  return handlerInput.responseBuilder
    .speak('Please link your account to continue. I sent a card to your Alexa app.')
    .withLinkAccountCard()
    .getResponse();
}

// Check if a date is a non-working day
function isNonWorkingDay(dateStr, userData) {
  const date = new Date(dateStr);
  const dayOfWeek = date.getDay();
  
  if (dayOfWeek === 0) return true;
  
  const weeklyDaysOff = userData.weeklyDaysOff || [];
  if (weeklyDaysOff.includes(dayOfWeek)) return true;
  
  return false;
}

// ============================================================
// ALEXA USER PROFILE & AUTHENTICATION
// ============================================================

// Get Alexa user profile from account linking
async function getAlexaUserProfile(accessToken) {
  try {
    const response = await fetch('https://api.amazon.com/user/profile', {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });
    
    if (response.ok) {
      return await response.json();
    }
  } catch (error) {
    console.error('Error fetching Alexa user profile:', error);
  }
  return null;
}
// ============================================================
// DATABASE OPERATIONS - USER MANAGEMENT (FLAT STRUCTURE)
// ============================================================

// FIXED: Find Google user by email in flat credentials collection
async function findGoogleUserByEmail(email) {
  await ensureFirebaseInitialized();
  const db = admin.firestore();
  
  try {
    const snap = await db.collection('credentials')
      .where('email', '==', email)
      .limit(1)
      .get();

    if (snap.empty) {
      return null;
    }

    const doc = snap.docs[0];
    const data = doc.data() || {};
    console.log(`Found matching Google user: ${doc.id} for email: ${email}`);
    return {
      uid: doc.id,
      key: data.key || doc.id,
      email: data.email,
      name: data.name || data.username || null
    };
  } catch (error) {
    console.error('Error finding Google user by email:', error);
    return null;
  }
}

// FIXED: Create Alexa user document in flat structure with "alexa-" prefix
async function createAlexaUserDocument(alexaUserId, alexaProfile, linkedGoogleUid = null, sharedKey = null) {
  const db = admin.firestore();
  
  // Use "alexa-" prefix to distinguish from Google UIDs
  const alexaDocId = `alexa-${alexaUserId}`;
  const userKey = sharedKey || `key-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  
  const alexaUserData = {
    alexaUserId: alexaUserId,
    email: alexaProfile?.email || null,
    name: alexaProfile?.name || 'Alexa User',
    type: 'alexa',
    key: userKey,
    linkedGoogleUid: linkedGoogleUid || null,
    mappedToGoogle: !!linkedGoogleUid,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };
  
  await db.collection('credentials').doc(alexaDocId).set(alexaUserData);
  
  console.log(`Created Alexa user document: ${alexaDocId}, key: ${userKey}, linked: ${!!linkedGoogleUid}`);
  return { alexaDocId, userKey };
}

// FIXED: Check if Alexa user already exists
async function getExistingAlexaUser(alexaUserId) {
  await ensureFirebaseInitialized();
  const db = admin.firestore();
  
  const alexaDocId = `alexa-${alexaUserId}`;
  const alexaDoc = await db.collection('credentials').doc(alexaDocId).get();
  
  if (alexaDoc.exists) {
    const data = alexaDoc.data();
    return {
      exists: true,
      alexaDocId,
      key: data.key,
      linkedGoogleUid: data.linkedGoogleUid || null,
      mappedToGoogle: data.mappedToGoogle || false
    };
  }
  
  return { exists: false };
}

// FIXED: Main user mapping function - simplified flat structure
async function findOrCreateUserMapping(handlerInput, alexaUserId, accessToken) {
  await ensureFirebaseInitialized();
  
  try {
    // Check if Alexa user already exists
    const existingAlexa = await getExistingAlexaUser(alexaUserId);
    
    if (existingAlexa.exists) {
      console.log(`Alexa user already exists: ${existingAlexa.alexaDocId}, key: ${existingAlexa.key}`);
      return existingAlexa.key; // Return the key for attendance access
    }
    
    // Get Alexa user profile
    const alexaProfile = await getAlexaUserProfile(accessToken);
    const alexaEmail = alexaProfile && alexaProfile.email;
    
    if (alexaEmail) {
      console.log(`Looking for Google user with email: ${alexaEmail}`);
      
      // Search for existing Google user with matching email
      const googleUser = await findGoogleUserByEmail(alexaEmail);
      
      if (googleUser) {
        console.log(`Found matching Google user: ${googleUser.uid}, sharing key: ${googleUser.key}`);
        
        // Create Alexa user linked to Google user (share the same key)
        const { userKey } = await createAlexaUserDocument(
          alexaUserId, 
          alexaProfile, 
          googleUser.uid, 
          googleUser.key
        );
        
        return userKey;
      }
      
      console.log('No matching Google user found by email');
    }
    
    // If no existing Google user found, create standalone Alexa user
    console.log('Creating standalone Alexa user');
    const { userKey } = await createAlexaUserDocument(alexaUserId, alexaProfile, null, null);
    
    return userKey;
    
  } catch (error) {
    console.error('Error in findOrCreateUserMapping:', error);
    // Fallback: create standalone Alexa user
    const { userKey } = await createAlexaUserDocument(alexaUserId, null, null, null);
    return userKey;
  }
}

// FIXED: Get attendance key - works with flat structure
async function getAttendanceKey(identifier) {
  await ensureFirebaseInitialized();
  const db = admin.firestore();
  
  try {
    // Check if this is an Alexa user (starts with "alexa-" or raw Alexa ID)
    let docId = identifier;
    
    if (identifier.startsWith('amzn1.ask.account.')) {
      docId = `alexa-${identifier}`;
    }
    
    const userDoc = await db.collection('credentials').doc(docId).get();
    
    if (userDoc.exists) {
      const data = userDoc.data();
      
      // If it's an Alexa user linked to Google, get the Google user's key
      if (data.linkedGoogleUid && data.mappedToGoogle) {
        const googleDoc = await db.collection('credentials').doc(data.linkedGoogleUid).get();
        if (googleDoc.exists && googleDoc.data().key) {
          return String(googleDoc.data().key).trim();
        }
      }
      
      // Return the user's own key
      if (data.key) {
        return String(data.key).trim();
      }
    }
    
    // Fallback: try as Google user directly
    if (!identifier.startsWith('alexa-')) {
      const googleDoc = await db.collection('credentials').doc(identifier).get();
      if (googleDoc.exists && googleDoc.data().key) {
        return String(googleDoc.data().key).trim();
      }
    }
  } catch (error) {
    console.error('Error getting attendance key:', error);
  }
  
  // Last resort: return the identifier itself
  return identifier;
}

// Get user key from Alexa user ID
async function getUserKey(handlerInput) {
  const alexaUserId = handlerInput.requestEnvelope.context.System.user.userId;
  const accessToken = getAccessToken(handlerInput);
  
  if (!accessToken) {
    throw new Error('No access token available');
  }
  
  // This will create mapping if needed and return the attendance key
  const attendanceKey = await findOrCreateUserMapping(handlerInput, alexaUserId, accessToken);
  return attendanceKey;
}

// Helper retained for compatibility
async function ensureUserCredentials(attendanceKey) {
  // Just return the key - no need to create anything
  return attendanceKey;
}

// ============================================================
// ATTENDANCE DATA OPERATIONS
// ============================================================

// FIXED: Get user data using attendance key
async function getUserData(attendanceKey) {
  await ensureFirebaseInitialized();
  const db = admin.firestore();
  
  const docRef = db.collection('attendance').doc(attendanceKey);
  const doc = await docRef.get();
  
  if (doc.exists) {
    return doc.data();
  }
  
  return {};
}

// FIXED: Update user data using attendance key
async function updateUserData(attendanceKey, updates) {
  await ensureFirebaseInitialized();
  const db = admin.firestore();
  
  const docRef = db.collection('attendance').doc(attendanceKey);
  await docRef.set(updates, { merge: true });
}

// Get day status with correct structure
async function getDayStatus(attendanceKey, date) {
  const userData = await getUserData(attendanceKey);
  
  if (userData.records && userData.records[date] !== undefined) {
    return userData.records[date] ? 'present' : 'absent';
  }
  
  if (userData.holidays && userData.holidays.some(h => h.date === date)) {
    const holiday = userData.holidays.find(h => h.date === date);
    return { status: 'holiday', name: holiday.name };
  }
  
  if (userData.notEnrolled && userData.notEnrolled.includes(date)) {
    return 'not-enrolled';
  }
  
  return null;
}

// Set day status with correct structure
async function setDayStatus(attendanceKey, date, status, extraData = {}) {
  const userData = await getUserData(attendanceKey);
  
  const records = userData.records || {};
  let holidays = userData.holidays || [];
  let notEnrolled = userData.notEnrolled || [];
  
  delete records[date];
  holidays = holidays.filter(h => h.date !== date);
  notEnrolled = notEnrolled.filter(d => d !== date);
  
  if (status === 'present') {
    records[date] = true;
  } else if (status === 'absent') {
    records[date] = false;
  } else if (status === 'holiday') {
    holidays.push({ date, name: extraData.holidayName || 'Holiday' });
  } else if (status === 'not-enrolled') {
    notEnrolled.push(date);
  }
  
  await updateUserData(attendanceKey, {
    records,
    holidays,
    notEnrolled,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  
  return { success: true };
}
// ============================================================
// ATTENDANCE CALCULATIONS
// ============================================================

// Monthly attendance calculation
async function calculateMonthlyAttendance(attendanceKey, yearMonth) {
  const userData = await getUserData(attendanceKey);
  const [year, month] = yearMonth.split('-').map(Number);
  
  const daysInMonth = new Date(year, month, 0).getDate();
  let presentDays = 0;
  let totalWorkingDays = 0;
  const today = getFormattedDate();
  
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    
    if (dateStr > today) continue;
    if (isNonWorkingDay(dateStr, userData)) continue;
    
    const isHoliday = userData.holidays && userData.holidays.some(h => h.date === dateStr);
    if (isHoliday) continue;
    
    const isNotEnrolled = userData.notEnrolled && userData.notEnrolled.includes(dateStr);
    if (isNotEnrolled) continue;
    
    totalWorkingDays++;
    
    if (userData.records && userData.records[dateStr] === true) {
      presentDays++;
    }
  }
  
  return totalWorkingDays > 0 ? Math.round((presentDays / totalWorkingDays) * 100) : 0;
}

// Session attendance calculation
async function calculateSessionAttendance(attendanceKey, sessionName = null) {
  const userData = await getUserData(attendanceKey);
  
  let startDate, endDate;
  let sessionUsed = 'current session';
  
  const sessions = userData.sessions || [];
  const selectedSession = sessions.find(s => s.isSelected === true);
  
  if (selectedSession) {
    startDate = selectedSession.startDate;
    endDate = selectedSession.endDate || getFormattedDate();
    sessionUsed = selectedSession.name || sessionUsed;
  }
  
  if ((!startDate || !endDate) && sessionName) {
    const session = sessions.find(s => 
      s.name.toLowerCase() === sessionName.toLowerCase() || 
      s.code === sessionName
    );
    if (session) {
      startDate = session.startDate;
      endDate = session.endDate;
      sessionUsed = session.name;
    }
  }
  
  if (!startDate || !endDate) {
    const currentYear = getLocalDate().getUTCFullYear();
    startDate = `${currentYear}-01-01`;
    endDate = `${currentYear}-12-31`;
    sessionUsed = 'current year';
  }
  
  const start = new Date(startDate);
  const end = new Date(endDate);
  const today = new Date(getFormattedDate());
  
  let presentDays = 0;
  let totalWorkingDays = 0;
  
  const currentDate = new Date(start);
  while (currentDate <= end && currentDate <= today) {
    const dateStr = currentDate.toISOString().split('T')[0];
    
    if (isNonWorkingDay(dateStr, userData)) {
      currentDate.setDate(currentDate.getDate() + 1);
      continue;
    }
    
    const isHoliday = userData.holidays && userData.holidays.some(h => h.date === dateStr);
    if (isHoliday) {
      currentDate.setDate(currentDate.getDate() + 1);
      continue;
    }
    
    const isNotEnrolled = userData.notEnrolled && userData.notEnrolled.includes(dateStr);
    if (isNotEnrolled) {
      currentDate.setDate(currentDate.getDate() + 1);
      continue;
    }
    
    totalWorkingDays++;
    
    if (userData.records && userData.records[dateStr] === true) {
      presentDays++;
    }
    
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  const percentage = totalWorkingDays > 0 ? Math.round((presentDays / totalWorkingDays) * 100) : 0;
  
  return {
    percentage,
    sessionName: sessionUsed,
    presentDays,
    totalWorkingDays
  };
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

// Set selected session
async function setAlexaPresetSession(attendanceKey, sessionIdentifier) {
  const userData = await getUserData(attendanceKey);
  if (!userData.sessions || userData.sessions.length === 0) {
    return { success: false, error: 'No sessions found' };
  }
  
  const found = userData.sessions.find(s => 
    s.code === sessionIdentifier || 
    (s.name && s.name.toLowerCase() === String(sessionIdentifier).toLowerCase())
  );
  
  if (!found) return { success: false, error: 'Session not found' };
  
  const sessions = userData.sessions.map(session => ({
    ...session,
    isSelected: session.code === found.code
  }));
  
  await updateUserData(attendanceKey, { sessions });
  return { success: true, session: found };
}

// Get selected session
async function getAlexaPresetSession(attendanceKey) {
  const userData = await getUserData(attendanceKey);
  const sessions = userData.sessions || [];
  return sessions.find(s => s.isSelected === true) || null;
}

// Clear selected session
async function clearAlexaPresetSession(attendanceKey) {
  const userData = await getUserData(attendanceKey);
  const sessions = userData.sessions || [];
  
  const updatedSessions = sessions.map(session => ({
    ...session,
    isSelected: false
  }));
  
  await updateUserData(attendanceKey, { sessions: updatedSessions });
  return { success: true };
}

// Save session
async function saveSession(attendanceKey, sessionName, startDate, endDate, setAsPreset = false) {
  const userData = await getUserData(attendanceKey);
  const sessions = userData.sessions || [];
  
  const sessionCode = generateSessionCode(sessionName);
  
  const sessionData = {
    name: sessionName,
    code: sessionCode,
    startDate,
    endDate,
    createdAt: new Date().toISOString(),
    isSelected: setAsPreset
  };
  
  const existingIndex = sessions.findIndex(s => 
    s.name.toLowerCase() === sessionName.toLowerCase() || 
    s.code === sessionCode
  );
  
  let updatedSessions;
  if (existingIndex !== -1) {
    updatedSessions = [...sessions];
    updatedSessions[existingIndex] = sessionData;
  } else {
    updatedSessions = [...sessions, sessionData];
  }
  
  if (setAsPreset) {
    updatedSessions = updatedSessions.map(session => ({
      ...session,
      isSelected: session.code === sessionCode
    }));
  }
  
  updatedSessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  
  await updateUserData(attendanceKey, { sessions: updatedSessions });
  
  return sessionData;
}

// Get available sessions
async function getAvailableSessions(attendanceKey) {
  const userData = await getUserData(attendanceKey);
  return userData.sessions || [];
}
// ============================================================
// INTENT HANDLERS - LAUNCH & ATTENDANCE MARKING
// ============================================================

const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
  },
  async handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    
    if (!accessToken) {
      return requireAccountLinking(handlerInput);
    }
    
    try {
      const attendanceKey = await getUserKey(handlerInput);
      await ensureUserCredentials(attendanceKey);
      
      const speechText = 'Welcome to Attendance Tracker! You can mark your attendance as present, absent, or holiday. You can also ask for monthly or session attendance percentages. What would you like to do?';
      
      return handlerInput.responseBuilder
        .speak(speechText)
        .reprompt('What would you like to do? You can say mark present, mark absent, or ask for attendance percentage.')
        .getResponse();
    } catch (error) {
      console.error('Error in LaunchRequest:', error);
      const speechText = 'Welcome to Attendance Tracker! What would you like to do?';
      return handlerInput.responseBuilder
        .speak(speechText)
        .reprompt('What would you like to do?')
        .getResponse();
    }
  }
};

const MarkPresentIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'MarkPresentIntent';
  },
  async handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    if (!accessToken) return requireAccountLinking(handlerInput);
    
    try {
      const attendanceKey = await getUserKey(handlerInput);
      await ensureUserCredentials(attendanceKey);
      
      const today = getFormattedDate();
      const userData = await getUserData(attendanceKey);
      
      if (isNonWorkingDay(today, userData)) {
        return handlerInput.responseBuilder
          .speak('Today is a non-working day. You cannot mark attendance on non-working days.')
          .getResponse();
      }
      
      const existingStatus = await getDayStatus(attendanceKey, today);
      
      if (existingStatus) {
        if (existingStatus.status === 'present' || existingStatus === 'present') {
          return handlerInput.responseBuilder
            .speak('Today is already marked as present.')
            .getResponse();
        } else {
          const sessionAttributes = handlerInput.attributesManager.getSessionAttributes();
          sessionAttributes.pendingStatusChange = {
            date: today,
            newStatus: 'present',
            oldStatus: existingStatus.status || existingStatus
          };
          handlerInput.attributesManager.setSessionAttributes(sessionAttributes);
          
          return handlerInput.responseBuilder
            .speak(`Today is currently marked as ${existingStatus.status || existingStatus}. Would you like to change it to present?`)
            .reprompt('Should I change today\'s status to present?')
            .getResponse();
        }
      }
      
      await setDayStatus(attendanceKey, today, 'present');
      
      return handlerInput.responseBuilder
        .speak('Successfully marked as present for today.')
        .getResponse();
        
    } catch (error) {
      console.error('Error in MarkPresentIntent:', error);
      return handlerInput.responseBuilder
        .speak('Sorry, I encountered an error while marking attendance. Please try again.')
        .getResponse();
    }
  }
};

const MarkAbsentIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'MarkAbsentIntent';
  },
  async handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    if (!accessToken) return requireAccountLinking(handlerInput);
    
    try {
      const attendanceKey = await getUserKey(handlerInput);
      await ensureUserCredentials(attendanceKey);
      
      const today = getFormattedDate();
      const userData = await getUserData(attendanceKey);
      
      if (isNonWorkingDay(today, userData)) {
        return handlerInput.responseBuilder
          .speak('Today is a non-working day. You cannot mark attendance on non-working days.')
          .getResponse();
      }
      
      const existingStatus = await getDayStatus(attendanceKey, today);
      
      if (existingStatus) {
        if (existingStatus.status === 'absent' || existingStatus === 'absent') {
          return handlerInput.responseBuilder
            .speak('Today is already marked as absent.')
            .getResponse();
        } else {
          const sessionAttributes = handlerInput.attributesManager.getSessionAttributes();
          sessionAttributes.pendingStatusChange = {
            date: today,
            newStatus: 'absent',
            oldStatus: existingStatus.status || existingStatus
          };
          handlerInput.attributesManager.setSessionAttributes(sessionAttributes);
          
          return handlerInput.responseBuilder
            .speak(`Today is currently marked as ${existingStatus.status || existingStatus}. Would you like to change it to absent?`)
            .reprompt('Should I change today\'s status to absent?')
            .getResponse();
        }
      }
      
      await setDayStatus(attendanceKey, today, 'absent');
      
      return handlerInput.responseBuilder
        .speak('Successfully marked as absent for today.')
        .getResponse();
        
    } catch (error) {
      console.error('Error in MarkAbsentIntent:', error);
      return handlerInput.responseBuilder
        .speak('Sorry, I encountered an error while marking attendance. Please try again.')
        .getResponse();
    }
  }
};

const MarkHolidayIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'MarkHolidayIntent';
  },
  async handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    if (!accessToken) return requireAccountLinking(handlerInput);
    
    const holidayName = Alexa.getSlotValue(handlerInput.requestEnvelope, 'holidayName');
    
    if (!holidayName) {
      return handlerInput.responseBuilder
        .speak('Please specify the holiday name. For example, say "mark holiday for Diwali".')
        .reprompt('What is the name of the holiday?')
        .getResponse();
    }
    
    try {
      const attendanceKey = await getUserKey(handlerInput);
      await ensureUserCredentials(attendanceKey);
      
      const today = getFormattedDate();
      const existingStatus = await getDayStatus(attendanceKey, today);
      
      if (existingStatus) {
        if (existingStatus.status === 'holiday' || existingStatus === 'holiday') {
          return handlerInput.responseBuilder
            .speak(`Today is already marked as holiday for ${existingStatus.name || 'a holiday'}.`)
            .getResponse();
        } else {
          const sessionAttributes = handlerInput.attributesManager.getSessionAttributes();
          sessionAttributes.pendingStatusChange = {
            date: today,
            newStatus: 'holiday',
            oldStatus: existingStatus.status || existingStatus,
            holidayName: holidayName
          };
          handlerInput.attributesManager.setSessionAttributes(sessionAttributes);
          
          return handlerInput.responseBuilder
            .speak(`Today is currently marked as ${existingStatus.status || existingStatus}. Would you like to change it to holiday for ${holidayName}?`)
            .reprompt(`Should I change today\'s status to holiday for ${holidayName}?`)
            .getResponse();
        }
      }
      
      await setDayStatus(attendanceKey, today, 'holiday', { holidayName });
      
      return handlerInput.responseBuilder
        .speak(`Successfully marked as holiday for ${holidayName}.`)
        .getResponse();
        
    } catch (error) {
      console.error('Error in MarkHolidayIntent:', error);
      return handlerInput.responseBuilder
        .speak('Sorry, I encountered an error while marking holiday. Please try again.')
        .getResponse();
    }
  }
};

const MonthlyAttendanceIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'MonthlyAttendanceIntent';
  },
  async handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    if (!accessToken) return requireAccountLinking(handlerInput);
    
    try {
      const attendanceKey = await getUserKey(handlerInput);
      await ensureUserCredentials(attendanceKey);
      
      const monthSlot = Alexa.getSlotValue(handlerInput.requestEnvelope, 'month');
      const yearMonth = monthSlot ? getYearMonthFromDate(monthSlot) : getYearMonthFromDate();
      
      const percentage = await calculateMonthlyAttendance(attendanceKey, yearMonth);
      
      const monthName = new Date(yearMonth + '-01').toLocaleString('en-US', { month: 'long', year: 'numeric' });
      
      return handlerInput.responseBuilder
        .speak(`Your attendance for ${monthName} is ${percentage} percent.`)
        .getResponse();
        
    } catch (error) {
      console.error('Error in MonthlyAttendanceIntent:', error);
      return handlerInput.responseBuilder
        .speak('Sorry, I encountered an error while fetching monthly attendance. Please try again.')
        .getResponse();
    }
  }
};

const SessionAttendanceIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'SessionAttendanceIntent';
  },
  async handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    if (!accessToken) return requireAccountLinking(handlerInput);
    
    try {
      const attendanceKey = await getUserKey(handlerInput);
      await ensureUserCredentials(attendanceKey);
      
      const sessionNameSlot = Alexa.getSlotValue(handlerInput.requestEnvelope, 'sessionName');
      
      const result = await calculateSessionAttendance(attendanceKey, sessionNameSlot);
      
      return handlerInput.responseBuilder
        .speak(`Your session attendance for ${result.sessionName} is ${result.percentage} percent. You have attended ${result.presentDays} out of ${result.totalWorkingDays} working days.`)
        .getResponse();
        
    } catch (error) {
      console.error('Error in SessionAttendanceIntent:', error);
      return handlerInput.responseBuilder
        .speak('Sorry, I encountered an error while fetching session attendance. Please try again.')
        .getResponse();
    }
  }
};

const GetAttendancePercentageIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'GetAttendancePercentageIntent';
  },
  async handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    if (!accessToken) return requireAccountLinking(handlerInput);
    
    try {
      const attendanceKey = await getUserKey(handlerInput);
      await ensureUserCredentials(attendanceKey);
      
      const result = await calculateSessionAttendance(attendanceKey);
      
      return handlerInput.responseBuilder
        .speak(`Your attendance percentage is ${result.percentage} percent for ${result.sessionName}. You have attended ${result.presentDays} out of ${result.totalWorkingDays} working days.`)
        .getResponse();
        
    } catch (error) {
      console.error('Error in GetAttendancePercentageIntent:', error);
      return handlerInput.responseBuilder
        .speak('Sorry, I encountered an error while fetching your attendance percentage. Please try again.')
        .getResponse();
    }
  }
};
// ============================================================
// INTENT HANDLERS - SESSION MANAGEMENT
// ============================================================

const SetAlexaPresetIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'SetAlexaPresetIntent';
  },
  async handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    if (!accessToken) return requireAccountLinking(handlerInput);
    
    const sessionName = Alexa.getSlotValue(handlerInput.requestEnvelope, 'sessionName');
    
    if (!sessionName) {
      try {
        const attendanceKey = await getUserKey(handlerInput);
        await ensureUserCredentials(attendanceKey);
        
        const sessions = await getAvailableSessions(attendanceKey);
        const presetSession = await getAlexaPresetSession(attendanceKey);
        
        if (sessions.length === 0) {
          return handlerInput.responseBuilder
            .speak('You don\'t have any sessions yet. Please create a session first by saying "create session".')
            .getResponse();
        }
        
        let speechText = `Your available sessions are: `;
        sessions.slice(0, 5).forEach((session, index) => {
          speechText += `${session.name}${session.isSelected ? ' (Alexa preset)' : ''}`;
          if (index < Math.min(sessions.length, 5) - 1) speechText += ', ';
        });
        
        if (presetSession) {
          speechText += `. Your current Alexa preset session is ${presetSession.name}.`;
        }
        
        speechText += ' Which session would you like to set as Alexa preset?';
        
        return handlerInput.responseBuilder
          .speak(speechText)
          .reprompt('Please tell me which session you want to set as Alexa preset.')
          .getResponse();
          
      } catch (error) {
        console.error('Error listing sessions:', error);
        return handlerInput.responseBuilder
          .speak('Sorry, I encountered an error while fetching your sessions. Please try again.')
          .getResponse();
      }
    }
    
    try {
      const attendanceKey = await getUserKey(handlerInput);
      await ensureUserCredentials(attendanceKey);
      
      const result = await setAlexaPresetSession(attendanceKey, sessionName);
      
      if (result.success) {
        return handlerInput.responseBuilder
          .speak(`Okay, I've set ${result.session.name} as your Alexa preset session. Now when you ask for session attendance, I'll automatically use this session.`)
          .getResponse();
      } else {
        return handlerInput.responseBuilder
          .speak(`Session "${sessionName}" not found. Please tell me which session you want to set as Alexa preset.`)
          .reprompt('Which session should I set as Alexa preset?')
          .getResponse();
      }
        
    } catch (error) {
      console.error('Error in SetAlexaPresetIntent:', error);
      return handlerInput.responseBuilder
        .speak('Sorry, I encountered an error while setting Alexa preset session. Please try again.')
        .getResponse();
    }
  }
};

const GetAlexaPresetIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'GetAlexaPresetIntent';
  },
  async handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    if (!accessToken) return requireAccountLinking(handlerInput);
    
    try {
      const attendanceKey = await getUserKey(handlerInput);
      await ensureUserCredentials(attendanceKey);
      
      const presetSession = await getAlexaPresetSession(attendanceKey);
      
      if (presetSession) {
        return handlerInput.responseBuilder
          .speak(`Your current Alexa preset session is ${presetSession.name}. It runs from ${formatAlexaDate(presetSession.startDate)} to ${formatAlexaDate(presetSession.endDate)}.`)
          .getResponse();
      } else {
        return handlerInput.responseBuilder
          .speak('You don\'t have an Alexa preset session set. You can set one by saying "set [session name] as Alexa preset".')
          .getResponse();
      }
        
    } catch (error) {
      console.error('Error in GetAlexaPresetIntent:', error);
      return handlerInput.responseBuilder
        .speak('Sorry, I encountered an error while fetching your Alexa preset session. Please try again.')
        .getResponse();
    }
  }
};

const ClearAlexaPresetIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'ClearAlexaPresetIntent';
  },
  async handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    if (!accessToken) return requireAccountLinking(handlerInput);
    
    try {
      const attendanceKey = await getUserKey(handlerInput);
      await ensureUserCredentials(attendanceKey);
      
      const result = await clearAlexaPresetSession(attendanceKey);
      
      if (result.success) {
        return handlerInput.responseBuilder
          .speak('I\'ve cleared your Alexa preset session. Next time you ask for attendance, I\'ll ask which session you want to use.')
          .getResponse();
      } else {
        return handlerInput.responseBuilder
          .speak('There was no Alexa preset session to clear.')
          .getResponse();
      }
        
    } catch (error) {
      console.error('Error in ClearAlexaPresetIntent:', error);
      return handlerInput.responseBuilder
        .speak('Sorry, I encountered an error while clearing your Alexa preset session. Please try again.')
        .getResponse();
    }
  }
};

const SelectSessionIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'SelectSessionIntent';
  },
  async handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    if (!accessToken) return requireAccountLinking(handlerInput);
    
    const sessionName = Alexa.getSlotValue(handlerInput.requestEnvelope, 'sessionName');
    
    if (!sessionName) {
      try {
        const attendanceKey = await getUserKey(handlerInput);
        await ensureUserCredentials(attendanceKey);
        
        const sessions = await getAvailableSessions(attendanceKey);
        
        if (sessions.length === 0) {
          return handlerInput.responseBuilder
            .speak('You don\'t have any sessions yet. Please create a session first by saying "create session".')
            .getResponse();
        }
        
        let sessionList = sessions.slice(0, 5).map(s => s.name).join(', ');
        if (sessions.length > 5) {
          sessionList += ', and more';
        }
        
        return handlerInput.responseBuilder
          .speak(`Your available sessions are: ${sessionList}. Which session would you like to use?`)
          .reprompt('Please tell me which session you want to use.')
          .getResponse();
          
      } catch (error) {
        console.error('Error listing sessions:', error);
        return handlerInput.responseBuilder
          .speak('Sorry, I encountered an error while fetching your sessions. Please try again.')
          .getResponse();
      }
    }
    
    try {
      const attendanceKey = await getUserKey(handlerInput);
      await ensureUserCredentials(attendanceKey);
      
      const sessions = await getAvailableSessions(attendanceKey);
      
      const exactCodeMatch = sessions.find(s => s.code === sessionName);
      if (exactCodeMatch) {
        await setAlexaPresetSession(attendanceKey, exactCodeMatch.code);
        return handlerInput.responseBuilder
          .speak(`Okay, I've set ${exactCodeMatch.name} as your current session and Alexa preset.`)
          .getResponse();
      }
      
      const nameMatches = sessions.filter(s => 
        s.name.toLowerCase() === sessionName.toLowerCase()
      );
      
      if (nameMatches.length === 1) {
        await setAlexaPresetSession(attendanceKey, nameMatches[0].code);
        return handlerInput.responseBuilder
          .speak(`Okay, I've set ${nameMatches[0].name} as your current session and Alexa preset.`)
          .getResponse();
      } else if (nameMatches.length > 1) {
        const sessionCodes = nameMatches.map(s => s.code).join(', ');
        const dateRanges = nameMatches.map(s => 
          `${formatAlexaDate(s.startDate)} to ${formatAlexaDate(s.endDate)}`
        ).join(' and ');
        
        return handlerInput.responseBuilder
          .speak(`I found ${nameMatches.length} sessions named "${sessionName}" with date ranges: ${dateRanges}. Please specify which one by using the session code: ${sessionCodes}`)
          .reprompt('Please tell me the session code to select the correct session.')
          .getResponse();
      } else {
        if (sessions.length === 0) {
          return handlerInput.responseBuilder
            .speak(`Session "${sessionName}" not found. You don't have any sessions yet. Please create a session first by saying "create session".`)
            .getResponse();
        }
        
        let sessionList = sessions.slice(0, 5).map(s => s.name).join(', ');
        if (sessions.length > 5) {
          sessionList += ', and more';
        }
        
        return handlerInput.responseBuilder
          .speak(`Session "${sessionName}" not found. Your available sessions are: ${sessionList}. Which session would you like to use?`)
          .reprompt('Please tell me which session you want to use.')
          .getResponse();
      }
        
    } catch (error) {
      console.error('Error in SelectSessionIntent:', error);
      return handlerInput.responseBuilder
        .speak('Sorry, I encountered an error while setting your session. Please try again.')
        .getResponse();
    }
  }
};

const ListSessionsIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'ListSessionsIntent';
  },
  async handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    if (!accessToken) return requireAccountLinking(handlerInput);
    
    try {
      const attendanceKey = await getUserKey(handlerInput);
      await ensureUserCredentials(attendanceKey);
      
      const sessions = await getAvailableSessions(attendanceKey);
      const presetSession = await getAlexaPresetSession(attendanceKey);
      
      if (sessions.length === 0) {
        return handlerInput.responseBuilder
          .speak('You don\'t have any sessions yet. You can create one by saying "create session".')
          .getResponse();
      }
      
      let speechText = `You have ${sessions.length} session${sessions.length > 1 ? 's' : ''}: `;
      
      sessions.slice(0, 5).forEach((session, index) => {
        speechText += `${session.name}`;
        if (session.isSelected) {
          speechText += ' (Alexa preset)';
        }
        if (index < Math.min(sessions.length, 5) - 1) {
          speechText += ', ';
        }
      });
      
      if (sessions.length > 5) {
        speechText += `, and ${sessions.length - 5} more`;
      }
      
      if (presetSession) {
        speechText += `. Your Alexa preset session is ${presetSession.name}.`;
      }
      
      return handlerInput.responseBuilder
        .speak(speechText)
        .getResponse();
        
    } catch (error) {
      console.error('Error in ListSessionsIntent:', error);
      return handlerInput.responseBuilder
        .speak('Sorry, I encountered an error while listing your sessions. Please try again.')
        .getResponse();
    }
  }
};
// ============================================================
// INTENT HANDLERS - SESSION CREATION
// ============================================================

const CreateSessionIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'CreateSessionIntent';
  },
  async handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    if (!accessToken) return requireAccountLinking(handlerInput);
    
    const setAsPreset = Alexa.getSlotValue(handlerInput.requestEnvelope, 'setAsPreset');
    const shouldSetAsPreset = setAsPreset && (setAsPreset.toLowerCase() === 'yes' || setAsPreset.toLowerCase() === 'true');
    
    try {
      const attendanceKey = await getUserKey(handlerInput);
      await ensureUserCredentials(attendanceKey);
      
      const sessionAttributes = handlerInput.attributesManager.getSessionAttributes();
      sessionAttributes.inSessionCreation = true;
      sessionAttributes.sessionCreationStep = 'name';
      sessionAttributes.shouldSetAsPreset = shouldSetAsPreset;
      handlerInput.attributesManager.setSessionAttributes(sessionAttributes);
      
      let speechText = 'Okay, let\'s create a new session. What would you like to name this session?';
      if (shouldSetAsPreset) {
        speechText += ' This session will be set as your Alexa preset.';
      }
      
      return handlerInput.responseBuilder
        .speak(speechText)
        .reprompt('What should I call this session?')
        .getResponse();
    } catch (error) {
      console.error('Error in CreateSessionIntent:', error);
      return handlerInput.responseBuilder
        .speak('Sorry, I encountered an error while starting session creation. Please try again.')
        .getResponse();
    }
  }
};

const CreateSessionWithNameIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'CreateSessionWithNameIntent';
  },
  async handle(handlerInput) {
    const accessToken = getAccessToken(handlerInput);
    if (!accessToken) return requireAccountLinking(handlerInput);
    
    const sessionName = Alexa.getSlotValue(handlerInput.requestEnvelope, 'sessionName');
    const setAsPreset = Alexa.getSlotValue(handlerInput.requestEnvelope, 'setAsPreset');
    const shouldSetAsPreset = setAsPreset && (setAsPreset.toLowerCase() === 'yes' || setAsPreset.toLowerCase() === 'true');
    
    if (!sessionName) {
      return handlerInput.responseBuilder
        .speak('Please provide a session name. For example, say "create session called Summer 2024".')
        .reprompt('What would you like to name this session?')
        .getResponse();
    }
    
    try {
      const attendanceKey = await getUserKey(handlerInput);
      await ensureUserCredentials(attendanceKey);
      
      const sessionAttributes = handlerInput.attributesManager.getSessionAttributes();
      sessionAttributes.inSessionCreation = true;
      sessionAttributes.sessionCreationStep = 'startDate';
      sessionAttributes.pendingSessionName = sessionName;
      sessionAttributes.shouldSetAsPreset = shouldSetAsPreset;
      handlerInput.attributesManager.setSessionAttributes(sessionAttributes);
      
      return handlerInput.responseBuilder
        .speak(`Okay, I'll create session "${sessionName}". When does this session start? Please provide a start date like "June 1st 2024" or "2024-06-01".`)
        .reprompt('Please tell me the start date for this session.')
        .getResponse();
        
    } catch (error) {
      console.error('Error in CreateSessionWithNameIntent:', error);
      return handlerInput.responseBuilder
        .speak('Sorry, I encountered an error while creating the session. Please try again.')
        .getResponse();
    }
  }
};

const DateIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'DateIntent';
  },
  async handle(handlerInput) {
    const sessionAttributes = handlerInput.attributesManager.getSessionAttributes();
    const attendanceKey = await getUserKey(handlerInput);
    
    if (sessionAttributes.inSessionCreation) {
      const dateValue = Alexa.getSlotValue(handlerInput.requestEnvelope, 'date');
      
      if (sessionAttributes.sessionCreationStep === 'startDate') {
        if (dateValue) {
          sessionAttributes.pendingStartDate = dateValue;
          sessionAttributes.sessionCreationStep = 'endDate';
          handlerInput.attributesManager.setSessionAttributes(sessionAttributes);
          
          return handlerInput.responseBuilder
            .speak(`Okay, starting on ${formatAlexaDate(dateValue)}. When does the session end?`)
            .reprompt('Please provide an end date for the session.')
            .getResponse();
        } else {
          return handlerInput.responseBuilder
            .speak('I didn\'t catch the start date. Please provide a start date like "June 1st 2024" or "2024-06-01".')
            .reprompt('When does the session start?')
            .getResponse();
        }
      } 
      else if (sessionAttributes.sessionCreationStep === 'endDate') {
        if (dateValue) {
          const sessionName = sessionAttributes.pendingSessionName;
          const startDate = sessionAttributes.pendingStartDate;
          const endDate = dateValue;
          const shouldSetAsPreset = sessionAttributes.shouldSetAsPreset || false;
          
          const sessionData = await saveSession(attendanceKey, sessionName, startDate, endDate, shouldSetAsPreset);
          
          delete sessionAttributes.inSessionCreation;
          delete sessionAttributes.sessionCreationStep;
          delete sessionAttributes.pendingSessionName;
          delete sessionAttributes.pendingStartDate;
          delete sessionAttributes.shouldSetAsPreset;
          handlerInput.attributesManager.setSessionAttributes(sessionAttributes);
          
          let speechText = `Successfully created session "${sessionData.name}" from ${formatAlexaDate(startDate)} to ${formatAlexaDate(endDate)}.`;
          if (shouldSetAsPreset) {
            speechText += ' I\'ve also set it as your Alexa preset session.';
          }
          
          return handlerInput.responseBuilder
            .speak(speechText)
            .getResponse();
        } else {
          return handlerInput.responseBuilder
            .speak('I didn\'t catch the end date. Please provide an end date like "August 31st 2024" or "2024-08-31".')
            .reprompt('When does the session end?')
            .getResponse();
        }
      }
    }
    
    const dateValue = Alexa.getSlotValue(handlerInput.requestEnvelope, 'date');
    if (dateValue) {
      return handlerInput.responseBuilder
        .speak(`You said the date is ${formatAlexaDate(dateValue)}. What would you like to do with this date?`)
        .reprompt('What would you like to do with this date?')
        .getResponse();
    }
    
    return handlerInput.responseBuilder
      .speak('I\'m not sure what date you\'re referring to. Please try again.')
      .getResponse();
  }
};
// ============================================================
// INTENT HANDLERS - CONFIRMATIONS & BUILT-INS
// ============================================================

const YesIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.YesIntent';
  },
  async handle(handlerInput) {
    const sessionAttributes = handlerInput.attributesManager.getSessionAttributes();
    
    if (sessionAttributes.pendingStatusChange) {
      const { date, newStatus, oldStatus, holidayName } = sessionAttributes.pendingStatusChange;
      const attendanceKey = await getUserKey(handlerInput);
      
      try {
        await ensureUserCredentials(attendanceKey);
        await setDayStatus(attendanceKey, date, newStatus, { holidayName });
        
        delete sessionAttributes.pendingStatusChange;
        handlerInput.attributesManager.setSessionAttributes(sessionAttributes);
        
        let speechText = `Okay, I've changed ${date} from ${oldStatus} to ${newStatus}`;
        if (newStatus === 'holiday' && holidayName) {
          speechText += ` for ${holidayName}`;
        }
        speechText += '.';
        
        return handlerInput.responseBuilder
          .speak(speechText)
          .getResponse();
          
      } catch (error) {
        console.error('Error confirming status change:', error);
        return handlerInput.responseBuilder
          .speak('Sorry, I encountered an error while updating the status. Please try again.')
          .getResponse();
      }
    }
    
    if (!sessionAttributes.inSessionCreation && !sessionAttributes.pendingStatusChange) {
      sessionAttributes.inSessionCreation = true;
      sessionAttributes.sessionCreationStep = 'name';
      handlerInput.attributesManager.setSessionAttributes(sessionAttributes);
      
      return handlerInput.responseBuilder
        .speak('Great! What would you like to name this session? For example, "Summer 2024" or "Academic Year 2024-25".')
        .reprompt('What should I call this session?')
        .getResponse();
    }
    
    const speechText = 'Okay, what would you like to do next?';
    return handlerInput.responseBuilder
      .speak(speechText)
      .reprompt(speechText)
      .getResponse();
  }
};

const NoIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.NoIntent';
  },
  handle(handlerInput) {
    const sessionAttributes = handlerInput.attributesManager.getSessionAttributes();
    if (sessionAttributes.pendingStatusChange) {
      delete sessionAttributes.pendingStatusChange;
    }
    if (sessionAttributes.inSessionCreation) {
      delete sessionAttributes.inSessionCreation;
      delete sessionAttributes.sessionCreationStep;
      delete sessionAttributes.pendingSessionName;
      delete sessionAttributes.pendingStartDate;
      delete sessionAttributes.shouldSetAsPreset;
    }
    handlerInput.attributesManager.setSessionAttributes(sessionAttributes);
    
    const speechText = 'Okay, I won\'t make any changes. Let me know if you need anything else.';
    
    return handlerInput.responseBuilder
      .speak(speechText)
      .getResponse();
  }
};

const HelpIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent';
  },
  handle(handlerInput) {
    const speechText = 'You can mark your attendance by saying: "mark present", "mark absent", or "mark holiday for [holiday name]". You can also ask for "monthly attendance" or "session attendance" to get your percentage. To create a session, say "create session" or "create session Summer 2024". When asked for dates, you can say things like "June first 2024" or "2024-06-01". To switch sessions, say "use session [session name]" or "use session [session code]". You can also set an Alexa preset session by saying "set [session name] as Alexa preset". What would you like to do?';
    
    return handlerInput.responseBuilder
      .speak(speechText)
      .reprompt(speechText)
      .getResponse();
  }
};

const CancelAndStopIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           (Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.CancelIntent' ||
            Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.StopIntent');
  },
  handle(handlerInput) {
    const speechText = 'Goodbye! Have a great day!';
    
    return handlerInput.responseBuilder
      .speak(speechText)
      .getResponse();
  }
};

const FallbackIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
           Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.FallbackIntent';
  },
  handle(handlerInput) {
    const speechText = 'Sorry, I didn\'t understand that. You can mark attendance, ask for percentages, or say help for more options. What would you like to do?';
    
    return handlerInput.responseBuilder
      .speak(speechText)
      .reprompt(speechText)
      .getResponse();
  }
};

const SessionEndedRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
  },
  handle(handlerInput) {
    console.log('Session ended with reason:', handlerInput.requestEnvelope.request.reason);
    return handlerInput.responseBuilder.getResponse();
  }
};

const ErrorHandler = {
  canHandle() {
    return true;
  },
  handle(handlerInput, error) {
    console.log('Error handled:', error);
    
    return handlerInput.responseBuilder
      .speak('Sorry, I had trouble doing what you asked. Please try again.')
      .reprompt('Please try again.')
      .getResponse();
  }
};

// ============================================================
// ALEXA SKILL BUILDER
// ============================================================

const skillBuilder = Alexa.SkillBuilders.custom();
const skill = skillBuilder
  .addRequestHandlers(
    LaunchRequestHandler,
    MarkPresentIntentHandler,
    MarkAbsentIntentHandler,
    MarkHolidayIntentHandler,
    MonthlyAttendanceIntentHandler,
    SessionAttendanceIntentHandler,
    GetAttendancePercentageIntentHandler,
    SetAlexaPresetIntentHandler,
    GetAlexaPresetIntentHandler,
    ClearAlexaPresetIntentHandler,
    SelectSessionIntentHandler,
    CreateSessionIntentHandler,
    CreateSessionWithNameIntentHandler,
    DateIntentHandler,
    ListSessionsIntentHandler,
    YesIntentHandler,
    NoIntentHandler,
    HelpIntentHandler,
    CancelAndStopIntentHandler,
    FallbackIntentHandler,
    SessionEndedRequestHandler
  )
  .addErrorHandlers(ErrorHandler)
  .create();

// ============================================================
// EXPRESS SERVER SETUP
// ============================================================

const app = express();
const adapter = new ExpressAdapter(skill, true, true);

// FIXED: Proper async middleware with error handling
app.use(async (req, res, next) => {
  if (req.method === 'POST' && req.headers['content-type'] === 'application/json') {
    try {
      req.rawBody = await getRawBody(req, {
        length: req.headers['content-length'],
        limit: '1mb',
        encoding: 'utf8'
      });
      req.body = JSON.parse(req.rawBody.toString());
      next();
    } catch (error) {
      console.error('Error parsing body:', error);
      return res.status(400).json({ error: 'Bad Request - Invalid JSON' });
    }
  } else {
    next();
  }
});

// Alexa endpoint
app.post('*', adapter.getRequestHandlers());

// Health check endpoint
app.get('*', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    message: 'Attendance Skill is running',
    timestamp: new Date().toISOString()
  });
});

// Export for Vercel
module.exports = app;
