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
import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL
} from 'firebase/storage';

// Firebase configuration retrieved from apps:sdkconfig
const firebaseConfig = {
  apiKey: "AIzaSyD7AcN-LpyjRprGflGc8dJt0H3zOvfCgmU",
  authDomain: "newagent-5837a.firebaseapp.com",
  projectId: "newagent-5837a",
  storageBucket: "newagent-5837a.firebasestorage.app",
  messagingSenderId: "831753432864",
  appId: "1:831753432864:web:e9cb25ca07d517fcd03145",
  databaseURL: "https://newagent-5837a.firebaseio.com"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

// Authentication Helpers
export {
  app,
  auth,
  db,
  storage,
  signInAnonymously,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  doc,
  setDoc,
  getDoc,
  onSnapshot,
  ref,
  uploadBytes,
  getDownloadURL
};
