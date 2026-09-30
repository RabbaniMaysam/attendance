// One entry per class. Each class has its own Google Sheet and backend.
//   key  = short name used in the student link:  .../?c=key
//   name = shown when someone opens the page without a class in the link
//   api  = address of that class's backend (the Apps Script web app, ending in /exec)
window.SIGNUP_CLASSES = [
  { key: 'econ573', name: 'ECON573',
    api: 'https://script.google.com/macros/s/AKfycbyL4eOHJAWCO0EX0Xtydvz7zw9UU1wVOe10_CiAiN9aqszwBlGGwUxuTyU6FVQuGjcdjA/exec' }
];
