const { createReceiver } = require('ilp-protocol-psk2')
const EventEmitter = require('events')
const getIlpPlugin = require('ilp-plugin')
const debug = require('debug')('express-web-monetization')
const { randomBytes } = require('crypto')
const pathToRegexp = require('path-to-regexp')
const fs = require('fs-extra')
const path = require('path')

class ExpressWebMonetization {
  constructor (opts) {
    this.connected = false
    this.plugin = (opts && opts.plugin) || getIlpPlugin()
    this.buckets = new Map()
    this.balanceEvents = new EventEmitter()
    this.maxBalance = (opts && opts.maxBalance) || Infinity
    this.cookieName = (opts && opts.cookieName) || '__monetizer'
    this.cookieOptions = {
      httpOnly: false
    }
    if (opts && opts.cookieOptions) {
      this.cookieOptions = Object.assign(opts.cookieOptions, this.cookieOptions)
    }
    this.receiverEndpointUrl = (opts && opts.receiverEndpointUrl) || '/__monetizer/:id'
  }

  generatePayerId (req) {
  // Check for cookie in request otherwise generate newId.
    const cookie = req.cookies[this.cookieName]
    if (cookie) {
      return cookie
    }
    return randomBytes(16).toString('hex')
  }

  async connect () {
    if (this.connected) return
    this.connected = true
    await this.plugin.connect()

    this.receiver = await createReceiver({
      plugin: this.plugin,
      paymentHandler: async params => {
        const amount = params.prepare.amount
        const id = params.prepare.destination.split('.').slice(-3)[0]

        let balance = this.buckets.get(id) || 0
        balance = Math.min(balance + Number(amount), this.maxBalance)
        this.buckets.set(id, balance)
        setImmediate(() => this.balanceEvents.emit(id, balance))
        debug('got money for bucket. amount=' + amount,
          'id=' + id,
          'balance=' + balance)

        await params.acceptSingleChunk()
      }
    })
  }

  awaitBalance (id, balance) {
    debug('awaiting balance. id=' + id, 'balance=' + balance)
    return new Promise(resolve => {
      const handleBalanceUpdate = _balance => {
        if (_balance < balance) return

        setImmediate(() =>
          this.balanceEvents.removeListener(id, handleBalanceUpdate))
        resolve()
      }

      this.balanceEvents.on(id, handleBalanceUpdate)
    })
  }
  spend (id, price) {
    const balance = this.buckets.get(id) || 0
    if (balance < price) {
      throw new Error('insufficient balance on id.' +
      ' id=' + id,
      ' price=' + price,
      ' balance=' + balance)
    }

    debug('spent money. id=' + id, 'price=' + price)
    this.buckets.set(id, balance - price)
  }

  receive () {
    return async (req, res, next) => {
      await this.connect()
      // const re = pathToRegexp(this.receiverEndpointUrl)
      // const monetizerUrl = re.exec(req.url)
      if (req.headers.accept !== 'application/spsp+json') {
        res.status(40).send('Wrong Headers')
      }

      const { destinationAccount, sharedSecret } =
        this.receiver.generateAddressAndSecret()

      const segments = destinationAccount.split('.')
      const resultAccount = segments.slice(0, -2).join('.') +
        '.' + req.params.id +
        '.' + segments.slice(-2).join('.')

      res.header('Content-Type', 'application/spsp+json')
      res.send({
        destination_account: resultAccount,
        shared_secret: sharedSecret.toString('base64')
      })
    }
  }

  mount () {
    return async (req, res, next) => {
      ;['awaitBalance', 'spend', 'balance'].forEach(key => {
        req[key] = (amount) => {
          return this[key](req.cookies[this.cookieName], amount)
        }
        if (key === 'balance') {
          this[key] = this.buckets.get(req.cookies[this.cookieName])
        }
        req[key] = req[key].bind(this)
      })
      // Send back cookie
      res.cookie(this.cookieName, this.generatePayerId(req), this.cookieOptions)
      next()
    }
  }

  serverClient () {
    return fs.readFileSync(path.resolve(__dirname, 'client.js'))
  }
}

// Make our own middlew
module.exports = ExpressWebMonetization
