const express = require('express')
const app = express()
const server = require('http').Server(app)
const {WebMonetizationMiddleware, ExpressWebMonetization} = require('..')
const router = express.Router()
const monetizer = new ExpressWebMonetization()
const fs = require('fs-extra')
const path = require('path')
const cookieParser = require('cookie-parser')

router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '/index.html'))
})
router.get(monetizer.receiverEndpointUrl, monetizer.receive.bind(monetizer))

router.get('/content/', async (req, res) => {
  await req.awaitBalance(100)
  req.spend(100)
  res.send(await fs.readFile(path.resolve(__dirname, 'example.png')))
})

router.get('/client.js', async (req, res) => {
  res.send(await fs.readFile(path.resolve(__dirname, '../client.js')))
})

app.use(cookieParser())
app.use(WebMonetizationMiddleware(monetizer))
app.use('/', router)
server.listen(8080, error => {
  error
    ? console.error(error)
    : console.info(`==> 🌎 Listening on port 8080. Visit http://localhost:8080/ in your browser.`)
})
