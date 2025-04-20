import Livefiles from './index.js'

const filemanager = new Livefiles({
  path: './',
  role: 'admin',
  username: 'supersu',
  password: 'supersu',
  host: 'localhost',
  port: 6969
})

// console.log(filemanager);
console.log(filemanager.info);
await filemanager.ready()
// await filemanager.close()