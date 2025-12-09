const http = require('http')
const fs = require('fs')
const path = require('path')
const qs = require('querystring')
const ReadyResource = require('ready-resource')
const { promisify } = require('util')
const archiver = require('archiver')

const { base64Logo } = require('./logo.js')

// Convert fs methods to promises
const stat = promisify(fs.stat)
const readdir = promisify(fs.readdir)
const mkdir = promisify(fs.mkdir)
const writeFile = promisify(fs.writeFile)
const access = promisify(fs.access)

class Livefiles extends ReadyResource {
  constructor (opts = {}) {
    super()
    if (opts.path && fs.existsSync(opts.path)) {
      this.path = opts.path
    } else {
      throw new Error('INCORRECT OR NO PATH SPECIFIED')
    }

    // Initialize logger following holesail pattern
    this.logger = opts.logger || { log: () => { } }

    // default role is user
    // user can view and download files but an admin can create and delete files
    this.role = opts.role === 'admin' ? 'admin' : 'user'

    this.username =
      opts.username && typeof opts.username !== 'boolean'
        ? opts.username
        : 'admin' // Basic auth username
    this.password =
      opts.password && typeof opts.password !== 'boolean'
        ? opts.password
        : 'admin' // Basic auth password

    this.port = opts.port && typeof opts.port !== 'boolean' ? opts.port : 5409

    this.host = this.host =
      opts.host && typeof opts.host !== 'boolean' ? opts.host : '127.0.0.1'

    // Memory management settings
    this.maxRequestSize = opts.maxRequestSize || 10 * 1024 * 1024 // 10MB default
    this.streamBufferSize = opts.streamBufferSize || 64 * 1024 // 64KB chunks
  }

  async createZipArchive(dirPath, outputStream) {
    return new Promise((resolve, reject) => {
      try {
        const archive = archiver('zip', {
          zlib: { level: 5 }
        });

        archive.on('error', err => {
          this.logger.log({ type: 3, msg: `Archive error: ${err.message}` });
          reject(err);
        });

        archive.on('warning', err => {
          if (err.code === 'ENOENT') {
            this.logger.log({ type: 2, msg: `Archive warning: ${err.message}` });
          } else {
            this.logger.log({ type: 3, msg: `Archive warning: ${err.message}` });
            reject(err);
          }
        });

        archive.on('end', () => {
          this.logger.log({ type: 1, msg: `Archive created for: ${dirPath}` });
          resolve();
        });

        outputStream.on('error', err => {
          this.logger.log({ type: 3, msg: `Output stream error: ${err.message}` });
          reject(err);
        });

        archive.pipe(outputStream);

        archive.directory(dirPath, false, (entryData) => {
          try {
            fs.accessSync(path.join(dirPath, entryData.name), fs.constants.R_OK);
            return entryData;
          } catch (err) {
            this.logger.log({ type: 2, msg: `Skipping inaccessible file: ${entryData.name}` });
            return false;
          }
        });

        archive.finalize();
      } catch (err) {
        this.logger.log({ type: 3, msg: `Error in createZipArchive: ${err.message}` });
        reject(err);
      }
    });
  }

  async _open () {
    // initialise local http server
    this.server = http.createServer(this.handleRequest.bind(this))
    this.server.listen(this.port, this.host, err => {
      if (err) {
        this.logger.log({ type: 3, msg: `Failed to start server on port ${this.port}: ${err.message}` })
        process.exit(1)
      }
      this.logger.log({ type: 1, msg: `Livefiles server started on ${this.host}:${this.port}` })
    })
  }

  async _close () {
    if (this.server) {
      this.server.close()
      this.logger.log({ type: 1, msg: 'Livefiles server closed' })
    }
  }

  handleRequest (req, res) {
    const [rawPath] = req.url.split('?')
    const urlPath = decodeURIComponent(rawPath || '/')
    const fullPath = path.join(this.path, urlPath)

    // Basic authentication check
    if (!this.authenticate(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Filemanager"' })
      res.end('Authentication required.')
      return
    }

    if (req.method === 'GET') {
      this.handleGetRequest(fullPath, urlPath, res, req)
    } else if (req.method === 'POST') {
      this.handlePostRequest(req, res, urlPath)
    } else {
      res.writeHead(405, {'Content-Type': 'text/plain'})
      res.end('Method Not Allowed')
    }
  }

  authenticate (req) {
    const authHeader = req.headers.authorization
    if (authHeader) {
      const encodedCredentials = authHeader.split(' ')[1]
      const credentials = Buffer.from(encodedCredentials, 'base64').toString(
        'utf-8'
      )
      const [username, password] = credentials.split(':')
      return username === this.username && password === this.password
    }
    return false
  }

  async handleGetRequest (fullPath, urlPath, res, req) {
    try {
      const stats = await stat(fullPath);
      const cleanUrl = req.url.split('?')[0];
      const isZipDownload = req.url.includes('?download=zip');

      if (stats.isDirectory()) {
        if (isZipDownload) {
          try {
            await access(fullPath, fs.constants.R_OK);
            this.serveFile(fullPath, req, res, true);
          } catch (err) {
            this.logger.log({ type: 3, msg: `Access error for zip download: ${err.message}` });
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Directory not accessible');
          }
        } else {
          await this.listDirectory(fullPath, urlPath, res);
        }
      } else if (stats.isFile()) {
        this.serveFile(fullPath, req, res)
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.logger.log({ type: 3, msg: `File not found: ${fullPath}` });
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File Not Found');
      } else {
        this.logger.log({ type: 3, msg: `Error handling GET request: ${err.message}` });
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
    }
  }

  handlePostRequest (req, res, urlPath) {
    let body = ''
    let totalSize = 0

    // Memory protection: limit request size
    req.on('data', chunk => {
      totalSize += chunk.length

      // Prevent memory exhaustion from large requests
      if (totalSize > this.maxRequestSize) {
        res.writeHead(413, { 'Content-Type': 'text/plain' })
        res.end('Request entity too large')
        req.destroy()
        return
      }

      body += chunk.toString()
    })

    req.on('end', async () => {
      try {
        const formData = qs.parse(body)
        const itemType = formData.item_type
        const name = formData.name
        const directory = formData.directory

        // Basic validation
        if (
          !itemType ||
          !name ||
          typeof name !== 'string' ||
          !['folder', 'file'].includes(itemType)
        ) {
          res.writeHead(400, { 'Content-Type': 'text/plain' })
          res.end('Bad Request: Missing or invalid form data.')
          return
        }

        // Check user type for folder creation
        if (itemType === 'folder' && this.role !== 'admin') {
          res.writeHead(403, { 'Content-Type': 'text/plain' })
          res.end('Forbidden: Only admin users can create folders.')
          return
        }

        const newFullPath = path.join(this.path, directory || '.', name)

        if (itemType === 'folder') {
          await this.createFolder(newFullPath, res, urlPath)
        } else if (itemType === 'file') {
          await this.createFile(newFullPath, res, urlPath)
        }
      } catch (error) {
        this.logger.log({ type: 3, msg: `Error processing POST request: ${error.message}` })
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Internal Server Error')
      }
    })

    req.on('error', (err) => {
      this.logger.log({ type: 3, msg: `Request error: ${err.message}` })
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Request processing error')
      }
    })
  }

  async calculateDirectorySize (dirPath) {
    let totalSize = 0
    try {
      const items = await readdir(dirPath, { withFileTypes: true })

      // Process files in batches to avoid blocking event loop
      for (let i = 0; i < items.length; i += 10) {
        const batch = items.slice(i, i + 10)

        await Promise.all(batch.map(async (item) => {
          if (!item.isDirectory()) {
            try {
              const itemPath = path.join(dirPath, item.name)
              const stats = await stat(itemPath)
              totalSize += stats.size
            } catch (e) {
              // Skip files that can't be accessed
            }
          }
        }))

        // Yield control to event loop between batches
        if (i + 10 < items.length) {
          await new Promise(resolve => setImmediate(resolve))
        }
      }

      return totalSize
    } catch (e) {
      this.logger.log({ type: 2, msg: `Error calculating directory size: ${e.message}` })
      return 0
    }
  }

  async listDirectory (fullPath, urlPath, res) {
    try {
      const files = await readdir(fullPath, { withFileTypes: true })

      // Separate and sort directories and files
      const folders = files.filter(file => file.isDirectory())
      const normalFiles = files.filter(file => !file.isDirectory())
      const allFiles = [...folders, ...normalFiles]

      // Process files in batches to avoid blocking
      const directoryItems = []

      for (let i = 0; i < allFiles.length; i += 5) {
        const batch = allFiles.slice(i, i + 5)

        const batchResults = await Promise.all(batch.map(async (file) => {
          try {
            // Check if file is readable
            await access(path.join(fullPath, file.name), fs.constants.R_OK)

            const filePath = path.join(urlPath, file.name)
            const safeFileName = this.escapeHtml(file.name)
            const iconHtml = file.isDirectory()
                ? '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1a244f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>'
                : '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1a244f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V9l-7-7z"/><path d="M13 3v6h6"/></svg>'

            const downloadButton = file.isDirectory()
                ? `<div class="download-buttons">
              <a class="open--btn" href="${filePath}">Enter</a>
              <a class="download--btn" href="${filePath}?download=zip"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"> <g id="Interface / Download"> <path id="Vector" d="M6 21H18M12 3V17M12 17L17 12M12 17L7 12" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path> </g> </g></svg>.zip</a>
              </div>
              `
              : `<a href="${filePath}" download>Download</a>`

            // Get file or folder size (optimized)
            let size
            if (file.isDirectory()) {
              // For directories, calculate size asynchronously
              const dirSize = await this.calculateDirectorySize(path.join(fullPath, file.name))
              size = this.formatBytes(dirSize)
            } else {
              const stats = await stat(path.join(fullPath, file.name))
              size = this.formatBytes(stats.size)
            }

            return `<tr><td class="file--name">${iconHtml}<a href="${filePath}">${safeFileName}</a></td><td class="download--btn">${downloadButton}</td><td>${size}</td></tr>`
          } catch {
            return null // Skip if not readable
          }
        }))

        directoryItems.push(...batchResults.filter(item => item !== null))

        // Yield control to event loop between batches
        if (i + 5 < allFiles.length) {
          await new Promise(resolve => setImmediate(resolve))
        }
      }

      const directoryList = directoryItems.join('')

      let createFormHtml = ''
      if (this.role === 'admin') {
        createFormHtml = `
    <form method="POST" action="${urlPath}">
        <div>
            <label for="item_type">New Item Type</label>
            <select name="item_type" id="item_type">
                <option value="folder">Folder</option>
                <option value="file">File</option>
            </select>
        </div>
        <div>
            <label for="name">Name</label>
            <input type="text" name="name" id="name" placeholder="Name of the file/folder*" required>
        </div>
        <div>
            <label for="directory">Select Directory</label>
            <select name="directory" id="directory">
                <option value="">Current Directory</option>
                ${await this.getDirectoryOptions()}
            </select>
        </div>
        <button class="btn" type="submit">Create</button>
    </form>`
      }

      const htmlResponse = `
                <!DOCTYPE html>
                <html>
                <head>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Directory Listing | Filemanager</title>
                    <style>
                        body {
                        font-family: "Intern", sans-serif;
                        background-color: #f3f3f3;
                        margin: 0;
                        padding: 0;
                        color: #333;
                    }
                        .go--back--btn{
                        text-decoration: none;
                        color: #444;
                        cursor: pointer;
                        display: flex;
                        flex-direction: row;
                        align-items: center; 
                        margin: 2rem 2rem 1rem 2rem;
                        }
                        nav{
                        display:flex;
                        align-items: center;
                        justify-content: center;
                        gap: 10px;
                        }
                        nav p{
                        font-size: 3.4rem;
                        font-weight: 700;
                        }
                        .nav--icon{
                        width: 80px;
                        }
                    h1 {
                        color: #444;
                        font-size: 24px;
                        padding: 0 2rem;
                    }
                    a {
                        color: #333;
                        font-size: 16px;
                    }
                        .open--btn{
                        padding: 8px 14px;
                        font-size: 16px;
                        background: #fff !important;
                        border: 1px solid #242424;
                        color: #000 !important;

                        }
                       .container{
    padding: 0 2rem 2rem 2rem; 
                       }
                   table {
    width: 100%;
    max-width: 100%;
    border-collapse: collapse;
    border-radius: 15px;
    background-color: #fff;
}
.download-buttons{
display: flex;
flex-direction: row;
gap: 4px;
align-items: center;
}
    .table--container{
    border: 0.5px solid #bbb;
    border-radius: 15px;
    }

                    td {
                        text-align: left;
                        font-weight: 700;
                    }
                        td:nth-child(odd){
                        display: flex;
                        align-items: center;
                        gap: 10px;
                        }
                        td:nth-child(odd) a{
                        width: 100%;
                        }
                    th {
                    text-align: left;
                        border-bottom: 0.5px solid #bbb;
                        font-weight: 300;
                        font-size: 14px;
                        background-color: #fff;
                    }
                          table tr:first-child th:first-child {
        border-top-left-radius: 15px;
    }

    table tr:first-child th:last-child {
        border-top-right-radius: 15px;
    }

    table tr:last-child td:first-child {
        border-bottom-left-radius: 15px;
    }

    table tr:last-child td:last-child {
        border-bottom-right-radius: 15px;
    }
                        th:nth-child(1){
                    padding: 0.5rem 2rem;
                        }
                    tr:hover {
                        background-color: #f3f3f3;
                    }
                    .btn {
                        background-color: #E94E47;
                        border: none;
                        color: #fff;
                        padding: 8px 14px;
                        text-align: center;
                        text-decoration: none;
                        display: inline-block;
                        font-size: 18px;
                        cursor: pointer;
                        border-radius: 4px;
                    }
                    .btn:hover {
                        background-color: #ca271f;
                    }
                        .download--btn{
                        width: 120px;
                        }
                        .download--btn a {
                        background-color: #E94E47;
                        padding: 10px;
                        border-radius: 7px;
                        text-decoration: none;
                        color: #fff;
                        display: flex;
                        width: 80px !important;
                        }
                        .file--name{
                        padding: 4px 14px;
                        margin: 0.5rem 0;
                        }
                        .file--name a{
                        text-decoration: none;
                        color: #555;
                        }

                        form {
                        padding: 1rem 1rem;
                        border-radius: 15px;
                        width: 340px;
                        display: flex;
                        flex-direction: column;
                        gap: 1rem;
                        background: #fff;
                        margin: 1rem 0 3rem 0;
                        border: 0.5px solid #bbb;
                        }
                        input{
                        padding: 0.8rem 1rem;
                        border-radius: 7px;
                        border: 0.5px solid #bbb;
                        outline: none;
                        }
                        form div{
                        width: 340px;
                        display: flex;
                        flex-direction: column;
                        }
                        form select{
                        padding: 0.8rem 1rem;
                        border-radius: 7px;
                        border: 0.5px solid #bbb;
                        outline: none;
                        cursor: pointer;
                        color: #777;
                        }
                        form label{
                        color: #555;
                        font-size: 14px;
                        font-weight: 700;
                        padding: 2px 10px;
                        }
                        form .btn{ 
                        width: 100%;
                        margin-top: 0rem;
                        border-radius: 7px;
                        padding: 0.6rem 0;
                        }
                        footer{
                        display: flex;
                        gap: 1rem;
                        justify-content: center;
                        margin-bottom: 2rem;
                        }
                        @media screen and (max-width: 650px){
                         nav{
                         padding: 0 1rem;
                        justify-content: start;
                        }
                        nav p{
                        font-size: 1.4rem;
                        font-weight: 700;
                        }
                        h1{
                        padding: 0 1rem;
                        margin-block: 0;
                        }
                        .go--back--btn{
                        margin: 1rem;
                        }
                        .container{
                        padding: 0 1rem;
                        }
                        .nav--icon{
                        width: 30px;
                        }
                        form{
                        width: -webkit-fill-available;
                        }
                        form div, form button{
                        width: 100%;
                        }
                         footer{
                        justify-content: flex-start;
                        padding: 0 1.4rem;
                        gap: 10px;
                        }
                        }
                    </style>
                </head>
                <body>
                <nav>
                <img class="nav--icon" src="${base64Logo}"></img>
                <p>livefiles</p>
                </nav>
                <h1>Folder and Files: ${this.escapeHtml(urlPath)}</h1>
                <p class="go--back--btn" onclick="goback()">go back</p>
                    <div class="container">
                   <div class="table--container">
                    <table>
                        <tr>
                            <th>Name</th>
                            <th>Actions</th>
                            <th>Size</th>

                        </tr>
                        ${directoryList}
                    </table>
                   </div>
                    ${createFormHtml}
                    </div>
                    <footer>
                    <a>Discord</a>
                   &#183;
                    <a>Support</a>
                    &#183;
                    <a>&copy; 2024 Holesail</a>
                    </footer>
                </body>
                <script>
                function goback(){
                window.history.back();
                }
                </script>
                </html>
            `
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(htmlResponse)
    } catch (err) {
      this.logger.log({ type: 3, msg: `Error listing directory: ${err.message}` })
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('Internal Server Error')
    }
  }

  formatBytes (bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes'
    const k = 1024
    const dm = decimals < 0 ? 0 : decimals
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i]
  }

  serveFile (fullPath, req, res, isZip = false) {
    if (isZip) {
      try {
        const dirName = path.basename(fullPath);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${dirName}.zip"`
        });

        this.createZipArchive(fullPath, res)
            .catch(err => {
              this.logger.log({ type: 3, msg: `Error creating zip: ${err.message}` });
              if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error creating zip archive');
              }
            });
        return;
      } catch (err) {
        this.logger.log({ type: 3, msg: `Error in zip creation: ${err.message}` });
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error creating zip archive');
        return;
      }
    }
    const extension = path.extname(fullPath).toLowerCase()
    const contentType =
      this.getContentType(extension) || 'application/octet-stream'

    fs.stat(fullPath, (err, stats) => {
      if (err) {
        this.logger.log({ type: 3, msg: `Error reading file stats: ${err.message}` })
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Error reading file.')
        return
      }

      const fileSize = stats.size
      const range = req.headers.range

      if (range) {
        // Example: "bytes=1000-"
        const parts = range.replace(/bytes=/, '').split('-')
        const start = parseInt(parts[0], 10)
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1

        // Handle invalid ranges
        if (start >= fileSize || end >= fileSize) {
          res.writeHead(416, {
            'Content-Range': `bytes */${fileSize}`
          })
          res.end()
          return
        }

        const chunkSize = end - start + 1
        const fileStream = fs.createReadStream(fullPath, {
          start,
          end,
          highWaterMark: this.streamBufferSize // Control memory usage
        })

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${path.basename(
            fullPath
          )}"`
        })

        fileStream.pipe(res)

        // Handle stream errors
        fileStream.on('error', (err) => {
          this.logger.log({ type: 3, msg: `File stream error: ${err.message}` })
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' })
            res.end('Error reading file')
          }
        })
      } else {
        // Normal download with controlled buffer size
        const fileStream = fs.createReadStream(fullPath, {
          highWaterMark: this.streamBufferSize // Control memory usage
        })
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
          'Content-Disposition': `attachment; filename="${path.basename(
            fullPath
          )}"`
        })

        fileStream.pipe(res)

        // Handle stream errors
        fileStream.on('error', (err) => {
          this.logger.log({ type: 3, msg: `File stream error: ${err.message}` })
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' })
            res.end('Error reading file')
          }
        })
      }
    })
  }

  async createFolder (newFullPath, res, urlPath) {
    try {
      await mkdir(newFullPath, { recursive: true })
      this.logger.log({ type: 1, msg: `Created folder: ${newFullPath}` })
      res.writeHead(302, { Location: urlPath })
      res.end()
    } catch (err) {
      this.logger.log({ type: 3, msg: `Error creating folder: ${err.message}` })
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('Error creating folder.')
    }
  }

  async createFile (newFullPath, res, urlPath) {
    try {
      await writeFile(newFullPath, '')
      this.logger.log({ type: 1, msg: `Created file: ${newFullPath}` })
      res.writeHead(302, { Location: urlPath })
      res.end()
    } catch (err) {
      this.logger.log({ type: 3, msg: `Error creating file: ${err.message}` })
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('Error creating file.')
    }
  }

  getContentType (extension) {
    const mimeTypes = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.xml': 'application/xml',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.py': 'text/x-python',
      '.c': 'text/x-c',
      '.cpp': 'text/x-c++src',
      '.h': 'text/x-c',
      '.sh': 'text/x-shellscript',
      '.pdf': 'application/pdf',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.ico': 'image/x-icon',
      '.svg': 'image/svg+xml',
      '.mp3': 'audio/mpeg',
      '.bmp': 'image/bmp',
      '.webp': 'image/webp',
      '.zip': 'application/zip',
      '.rar': 'application/x-rar-compressed',
      '.tar': 'application/x-tar',
      '.gz': 'application/x-gzip',
      '.bz2': 'application/x-bzip2',
      '.7z': 'application/x-7z-compressed',
      '.wav': 'audio/x-wav',
      '.ogg': 'audio/ogg',
      '.flac': 'audio/x-flac',
      '.m4a': 'audio/x-m4a',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.ogv': 'video/ogg',
      '.avi': 'video/x-msvideo',
      '.mov': 'video/quicktime',
      '.wmv': 'video/x-ms-wmv',
      '.flv': 'video/x-flv',
      '.mkv': 'video/x-matroska',
      '.exe': 'application/x-msdownload'
    }
    return mimeTypes[extension] || null
  }

  async getDirectoryOptions () {
    const basePath = this.path
    const traverseDirectory = async (dir, depth = 0) => {
      let options = ''
      try {
        const items = await readdir(dir, { withFileTypes: true })

        // Process directories in batches to avoid blocking
        for (let i = 0; i < items.length; i += 10) {
          const batch = items.slice(i, i + 10).filter(item => item.isDirectory())

          for (const item of batch) {
            const itemPath = path.join(dir, item.name)
            const displayPath = itemPath.replace(basePath, '')
            const indent = '&nbsp;'.repeat(depth * 4)
            options += `<option value="${displayPath}">${indent}${item.name}</option>`

            // Recursively traverse subdirectories (with depth limit)
            if (depth < 5) { // Prevent infinite recursion
              options += await traverseDirectory(itemPath, depth + 1)
            }
          }

          // Yield control between batches
          if (i + 10 < items.length) {
            await new Promise(resolve => setImmediate(resolve))
          }
        }
      } catch (e) {
        // Skip directories that can't be accessed
      }
      return options
    }

    return await traverseDirectory(basePath)
  }

  escapeHtml (unsafe = '') {
    return unsafe
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  get info () {
    return {
      type: 'filemanager',
      host: this.host,
      port: this.port,
      role: this.role,
      username: this.username,
      password: this.password,
      maxRequestSize: this.maxRequestSize,
      streamBufferSize: this.streamBufferSize
    }
  }
}

module.exports = Livefiles
