import firebaseRulesPlugin from '@firebase/eslint-plugin-security-rules';

export default [
  {
    files: ['firestore.rules'],
    languageOptions: {
      parser: firebaseRulesPlugin.parsers.firestore,
    },
    plugins: {
      'firebase-rules': firebaseRulesPlugin,
    },
    rules: firebaseRulesPlugin.configs['flat/recommended'].rules,
  },
];
