const { createReceiver } = require('ilp-protocol-psk2')
const EventEmitter = require('events')
const getIlpPlugin = require('ilp-plugin')
const debug = require('debug')('express-web-monetization')
const { randomBytes } = require('crypto')

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

  async receive (req, res) {
    await this.connect()
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

// Make our own middleware
const WebMonetizationMiddleware = (monetizer) => {
  return async (req, res, next) => {
    ;['awaitBalance', 'spend'].forEach(key => {
      req[key] = (amount) => {
        monetizer[key] = monetizer[key].bind(monetizer)
        return monetizer[key](req.cookies[monetizer.cookieName], amount)
      }
      req[key] = req[key].bind(monetizer)
    })
    // Send back cookie
    res.cookie(monetizer.cookieName, monetizer.generatePayerId(req), monetizer.cookieOptions)
    next()
  }
}
module.exports = {
  WebMonetizationMiddleware,
  ExpressWebMonetization
}
