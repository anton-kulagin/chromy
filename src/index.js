const CDP = require('chrome-remote-interface')
const chainProxy = require('async-chain-proxy')
const uuidV4 = require('uuid/v4')
const devices = require('./devices')
const {
  TimeoutError,
  GotoTimeoutError,
  WaitTimeoutError,
  EvaluateTimeoutError
} = require('./error')
const {
  functionToEvaluatingSource
} = require('./functionToSource')
const {
  escapeHtml,
  createChromeLauncher
} = require('./util')

let instances = []
let instanceId = 1

function makeSendToChromy (uuid) {
  return `
  function () {
    console.info('${uuid}:' + JSON.stringify(arguments))
  }
  `
}

class Chromy {
  constructor (options = {}) {
    const defaults = {
      port: 9222,
      waitTimeout: 30000,
      gotoTimeout: 30000,
      loadTimeout: 30000,
      evaluateTimeout: 30000
    }
    this.options = Object.assign(Object.assign({}, defaults), options)
    this.cdpOptions = {
      port: this.options.port
    }
    this.client = null
    this.launcher = null
    this.messagePrefix = null
    this.emulateMode = false
    this.userAgentBeforeEmulate = null
    this.instanceId = instanceId++
  }

  chain (options = {}) {
    return chainProxy(this, options)
  }

  async start () {
    if (this.client !== null) {
      return
    }
    if (this.launcher === null) {
      this.launcher = createChromeLauncher(this.options)
    }
    await this.launcher.run()
    instances.push(this)
    await new Promise((resolve, reject) => {
      const actualCdpOptions = Object.assign({}, this.cdpOptions)
      Object.assign(actualCdpOptions, {
        target: (targets) => {
          return targets.filter(t => t.type === 'page').shift()
        }
      })
      CDP(actualCdpOptions, async (client) => {
        this.client = client
        const {Network, Page, Runtime, Console} = client
        await Promise.all([Network.enable(), Page.enable(), Runtime.enable(), Console.enable()])

        // focuses to first tab
        const targets = await this.client.Target.getTargets()
        const page = targets.targetInfos.filter(t => t.type === 'page').shift()
        await this.client.Target.activateTarget({targetId: page.targetId})

        if ('userAgent' in this.options) {
          await this.userAgent(this.options.userAgent)
        }
        if ('headers' in this.options) {
          await this.headers(this.options.headers)
        }
        resolve(this)
      }).on('error', (err) => {
        reject(err)
      })
    })
  }

  async close () {
    if (this.client === null) {
      return false
    }
    await this.client.close()
    this.client = null
    if (this.launcher !== null) {
      await this.launcher.kill()
      this.launcher = null
    }
    instances = instances.filter(i => i.instanceId !== this.instanceId)
    return true
  }

  static async cleanup () {
    const copy = [].concat(instances)
    const promises = copy.map(i => i.close())
    await Promise.all(promises)
  }

  async userAgent (ua) {
    await this.checkStart()
    return await this.client.Network.setUserAgentOverride({'userAgent': ua})
  }

  /**
   * Example:
   * chromy.headers({'X-Requested-By': 'foo'})
   */
  async headers (headers) {
    await this.checkStart()
    return await this.client.Network.setExtraHTTPHeaders({'headers': headers})
  }

  async console (callback) {
    await this.checkStart()
    this.client.Console.messageAdded((payload) => {
      try {
        const msg = payload.message.text
        const pre = this.messagePrefix
        if (typeof msg !== 'undefined') {
          if (pre === null || msg.substring(0, pre.length + 1) !== pre + ':') {
            callback.apply(this, [msg, payload.message])
          }
        }
      } catch (e) {
        console.warn(e)
      }
    })
  }

  async receiveMessage (callback) {
    await this.checkStart()
    const uuid = uuidV4()
    this.messagePrefix = uuid
    const f = makeSendToChromy(this.messagePrefix)
    this.defineFunction({sendToChromy: f})
    this.client.Console.messageAdded((payload) => {
      try {
        const msg = payload.message.text
        if (msg && msg.substring(0, uuid.length + 1) === uuid + ':') {
          const data = JSON.parse(msg.substring(uuid.length + 1))
          callback.apply(this, [data])
        }
      } catch (e) {
        console.warn(e)
      }
    })
  }

  async goto (url, options) {
    const defaultOptions = {
      waitLoadEvent: true
    }
    options = Object.assign(defaultOptions, options)
    await this.checkStart()
    try {
      await this._waitFinish(this.options.gotoTimeout, async () => {
        await this.client.Page.navigate({url: url})
        if (options.waitLoadEvent) {
          await this.client.Page.loadEventFired()
        }
      })
    } catch (e) {
      if (e instanceof TimeoutError) {
        throw new GotoTimeoutError('goto() timeout')
      } else {
        throw e
      }
    }
  }

  async waitLoadEvent () {
    await this._waitFinish(this.options.loadTimeout, async () => {
      await this.client.Page.loadEventFired()
    })
  }

  async forward () {
    const f = 'window.history.forward()'
    const promise = this.waitLoadEvent()
    await this.client.Runtime.evaluate({expression: f})
    await promise
  }

  async back () {
    const f = 'window.history.back()'
    const promise = this.waitLoadEvent()
    await this.client.Runtime.evaluate({expression: f})
    await promise
  }

  async reload (ignoreCache, scriptToEvaluateOnLoad) {
    await this.client.Page.reload({ignoreCache, scriptToEvaluateOnLoad})
  }

  async evaluate (expr) {
    let e = expr
    if ((typeof e) === 'function') {
      e = functionToEvaluatingSource(expr)
    }
    try {
      let result = await this._waitFinish(this.options.evaluateTimeout, async () => {
        if (!this.client) {
          return null
        }
        return await this.client.Runtime.evaluate({expression: e})
      })
      if (!result || !result.result) {
        return null
      }
      if (result.result.type === 'string') {
        const c = result.result.value.substring(0, 1)
        if (c === '{' || c === '"') {
          return JSON.parse(result.result.value)
        } else {
          return result.result.value
        }
      }
      return result.result.value
    } catch (e) {
      if (e instanceof TimeoutError) {
        throw new EvaluateTimeoutError('evaluate() timeout')
      } else {
        throw e
      }
    }
  }

  async _waitFinish (timeout, callback) {
    const start = Date.now()
    let finished = false
    let error = null
    let result = null
    const f = async () => {
      try {
        result = await callback.apply()
        finished = true
        return result
      } catch (e) {
        error = e
        finished = true
      }
    }
    f.apply()
    while (!finished) {
      const now = Date.now()
      if ((now - start) > timeout) {
        throw new TimeoutError('timeout')
      }
      await this.sleep(50)
    }
    if (error !== null) {
      throw error
    }
    return result
  }

  /**
   * define function
   *
   * @param func {(function|string|Array.<function>|Array.<string>)}
   * @returns {Promise.<void>}
   */
  async defineFunction (def) {
    let funcs = []
    if (Array.isArray(def)) {
      funcs = def
    } else if ((typeof def) === 'object') {
      funcs = this._moduleToFunctionSources(def)
    } else {
      funcs.push(def)
    }
    for (let i = 0; i < funcs.length; i++) {
      let f = funcs[i]
      if ((typeof f) === 'function') {
        f = f.toString()
      }
      await this.client.Runtime.evaluate({expression: f})
    }
  }

  _moduleToFunctionSources (module) {
    const result = []
    for (let funcName in module) {
      let func = module[funcName]
      let src = `function ${funcName} () { return (${func.toString()})(...arguments) }`.trim()
      result.push(src)
    }
    return result
  }

  async sleep (msec) {
    await new Promise((resolve, reject) => {
      setTimeout(() => {
        resolve()
      }, msec)
    })
  }

  async wait (cond) {
    if ((typeof cond) === 'number') {
      await this.sleep(cond)
    } else if ((typeof cond) === 'function') {
      await this._waitFunction(cond)
    } else {
      await this._waitSelector(cond)
    }
  }

  // wait for func to return true.
  async _waitFunction (func) {
    await this._waitFinish(this.options.evaluateTimeout, async () => {
      while (true) {
        let r = await this._waitFinish(1000, () => {
          return this.evaluate(func)
        })
        if (r) {
          break
        }
        await this.sleep(50)
      }
    })
  }

  async _waitSelector (selector) {
    let check = null
    let startTime = Date.now()
    await new Promise((resolve, reject) => {
      check = () => {
        setTimeout(async () => {
          try {
            const now = Date.now()
            if (now - startTime > this.options.waitTimeout) {
              reject(new WaitTimeoutError('wait() timeout'))
              return
            }
            const result = await this.evaluate(functionToEvaluatingSource(() => {
              return document.querySelector('?')
            }, {'?': escapeHtml(selector)}))
            if (result) {
              resolve(result)
            } else {
              check()
            }
          } catch (e) {
            reject(e)
          }
        }, 50)
      }
      check()
    })
  }

  async type (expr, value) {
    await this.evaluate('document.querySelector("' + expr + '").focus()')
    const characters = value.split('')
    for (let i in characters) {
      const c = characters[i]
      await this.client.Input.dispatchKeyEvent({type: 'char', text: c})
      await this.sleep(20)
    }
  }

  async insert (expr, value) {
    await this.evaluate('document.querySelector("' + expr + '").focus()')
    await this.evaluate('document.querySelector("' + expr + '").value = "' + escapeHtml(value) + '"')
  }

  async click (expr, inputOptions = {}) {
    const defaults = {waitLoadEvent: false}
    const options = Object.assign(defaults, inputOptions)
    let promise = null
    if (options.waitLoadEvent) {
      promise = this.waitLoadEvent()
    }
    await this.evaluate('document.querySelectorAll("' + expr + '").forEach(n => n.click())')
    if (promise !== null) {
      await promise
    }
  }

  async check (selector) {
    await this.evaluate('document.querySelectorAll("' + selector + '").forEach(n => n.checked = true)')
  }

  async uncheck (selector) {
    await this.evaluate('document.querySelectorAll("' + selector + '").forEach(n => n.checked = false)')
  }

  async select (selector, value) {
    const src = `
      document.querySelectorAll("${selector} > option").forEach(n => {
        if (n.value === "${value}") {
          n.selected = true
        }
      })
      `
    await this.evaluate(src)
  }

  async screenshot (format = 'png', quality = undefined, fromSurface = true) {
    if (['png', 'jpeg'].indexOf(format) === -1) {
      throw new Error('format is invalid.')
    }
    const {data} = await this.client.Page.captureScreenshot({format: format, quality: quality, fromSurface: fromSurface})
    return Buffer.from(data, 'base64')
  }

  async pdf (options = {}) {
    const {data} = await this.client.Page.printToPDF(options)
    return Buffer.from(data, 'base64')
  }

  async emulate (deviceName) {
    await this.checkStart()

    if (!this.emulateMode) {
      this.userAgentBeforeEmulate = await this.evaluate('return navigator.userAgent')
    }
    const device = devices[deviceName]
    await this.client.Emulation.setDeviceMetricsOverride({
      width: device.width,
      height: device.height,
      deviceScaleFactor: device.deviceScaleFactor,
      mobile: device.mobile,
      fitWindow: false,
      scale: device.pageScaleFactor
    })
    await this.userAgent(device.userAgent)
    this.emulateMode = true
  }

  async clearEmulate () {
    await this.client.Emulation.clearDeviceMetricsOverride()
    if (this.userAgentBeforeEmulate) {
      await this.userAgent(this.userAgentBeforeEmulate)
    }
    this.emulateMode = false
  }

  async checkStart () {
    if (this.client === null) {
      await this.start()
    }
  }
}

module.exports = Chromy

