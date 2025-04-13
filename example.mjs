import Livefiles from './index.js'

const filemanager = new Livefiles({
  path: './',
  role: 'admin',
  username: 'supersu',
  password: 'supersu',
  host: 'localhost',
  port: 8989
})
filemanager.start()
