import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInAnonymously, 
  GoogleAuthProvider, 
  signInWithPopup, 
  signOut, 
  onAuthStateChanged 
} from 'firebase/auth';
import { 
  getFirestore, 
  doc, 
  setDoc, 
  getDoc, 
  onSnapshot 
} from 'firebase/firestore';

// Firebase configuration retrieved from apps:sdkconfig
const firebaseConfig = {
  apiKey: "AIzaSyARr38GKvIzB55hbLgYliu78nTDjnRm99s",
  authDomain: "smartmirror-ed01c.firebaseapp.com",
  projectId: "smartmirror-ed01c",
  storageBucket: "smartmirror-ed01c.firebasestorage.app",
  messagingSenderId: "817403114465",
  appId: "1:817403114465:web:f62d22ae89936e247118a0",
  databaseURL: "https://smartmirror-ed01c.firebaseio.com"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Authentication Helpers
export {
  app,
  auth,
  db,
  signInAnonymously,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  doc,
  setDoc,
  getDoc,
  onSnapshot
};
