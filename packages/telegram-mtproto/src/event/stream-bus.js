//@flow

import type { EventEmitterType } from 'eventemitter2'
// import { taggedSum } from 'daggy'

import { fromEvents } from 'kefir'

import Config from '../config-provider'
import { makeEventStream } from './make-event-stream'

import type { MTProto } from '../service/main'
import type { RpcRawError } from './rpc'
import {
  onRpcError,
  isMigrateError,
  getMigrateDc,
  isFileMigrateError,
  getFileMigrateDc
} from './rpc'
import ApiRequest from '../service/main/request'
import Request from '../service/api-manager/request'
import NetworkerThread from '../service/networker'
import { NetMessage } from '../service/networker/net-message'
import { MTError, RpcError } from '../error'
import dcStoreKeys from '../util/dc-store-keys'
import { EventScope } from './scoped-emitter'


import Logger from 'mtproto-logger'
const log = Logger`stream-bus`

const makeStateScopes = (uid: string) => {
  const uidScope = EventScope.of(uid)
  const stateScope = EventScope.of('state')
  const messagesScope = EventScope.of('messages')
  const requestsScope = EventScope.of('requests')
  const stateMessages = stateScope.concat(messagesScope)
  const stateRequests = stateScope.concat(requestsScope)
  const fullScope = {
    requests: uidScope.concat(stateRequests).joined,
    messages: uidScope.concat(stateMessages).joined,
  }

  return fullScope
}

type BaseType =
  'INIT'
  | 'AUTH'
  | 'WORK'

const createStreamBus = (ctx: MTProto) => {
  const emitter = Config.rootEmitter(ctx.uid)
  const bus = makeStreamMap(emitter)

  // const baseState = fromEvents(
  //   ctx.emitter,
  //   [ctx.uid, 'base'].join('.'),
  //   (str: BaseType) => str
  // ).toProperty((): BaseType => 'INIT')
  bus.baseState.onValue(log('base state'))
  bus.baseState.onValue(e => console.log(e))
  const stateScopes = makeStateScopes(ctx.uid)

  bus.scopes = {
    messages: fromEvents(ctx.emitter, stateScopes.messages),
    requests: fromEvents(ctx.emitter, stateScopes.requests),
  }

  // pushMessage.onValue(log('push message'))

  bus.responseRaw.onValue(log('raw response'))
  bus.responseRaw.onError(log('raw error'))

  bus.incomingMessage.onValue(log('incoming message'))

  const state = ctx.state

  bus.incomingMessage.observe({
    value(val) {
      // ctx.state.messages.delete(val.message.msg_id)
      const networker = state.threads.get(val.threadID)
      if (networker == null) return
      log('observer', 'type')(val.message._, networker.dcID)
    }
  })

  bus.newNetworker.observe((networker) => {
    log('new networker')(networker)
    state.threads.set(networker.threadID, networker)
  })

  bus.messageIn.onValue(log('message in'))

  const apiOnly = bus.messageIn.filter(value => value.isAPI)
  const mtOnly = bus.messageIn.filter(value => !value.isAPI)

  apiOnly.observe({
    value(val) {
      ctx.state.messages.set(val.msg_id, val)

    }
  })
  mtOnly.observe({
    value(val) {
      ctx.state.messages.set(val.msg_id, val)

    }
  })

  bus.rpcResult.observe(async (data) => {
    log('rpc result')(data)
    ctx.state.messages.delete(data.sentMessage.msg_id)
    ctx.state.requests.delete(data.sentMessage.requestID)
    data.sentMessage.deferred.resolve(data.result)
  })

  bus.rpcError.onValue(log('rpc error'))

  const isAuthRestart = (error: MTError) =>
    error.code === 500 &&
    error.type === 'AUTH_RESTART'

  bus.rpcError.observe(async ({ error, ...data }: OnRpcError) => {
    if (isFileMigrateError(error)) {
      const newDc = getFileMigrateDc(error)
      if (typeof newDc !== 'number') throw error
      if (!ctx.state.messages.has(data.message.req_msg_id)) {
        data.sentMessage.deferred.reject(error)
        return log('on file migrate error')(data.message.req_msg_id, 'req_msg_id not found')
      }
      const msg = ctx.state.messages.get(data.message.req_msg_id)
      if (!msg || !msg.requestID || typeof msg.requestID !== 'string') {
        data.sentMessage.deferred.reject(error)
        return log('on file migrate error')('msg', msg)
      }
      const req = ctx.state.requests.get(msg.requestID)
      if (!req) {
        data.sentMessage.deferred.reject(error)
        return log('on file migrate error')('req', req)
      }
      req.options.dc = newDc
      log('file migrate', 'req')(req)
      log('on file migrate restart')('before end')
      await ctx.api.invokeNetRequest(req)
    } if (isMigrateError(error)) {
      const newDc = getMigrateDc(error)
      if (typeof newDc !== 'number') throw error
      await ctx.storage.set('dc', newDc)
      if (!ctx.state.messages.has(data.message.req_msg_id)) {
        data.sentMessage.deferred.reject(error)
        return log('on migrate error')(data.message.req_msg_id, 'req_msg_id not found')
      }
      const msg = ctx.state.messages.get(data.message.req_msg_id)
      if (!msg || !msg.requestID || typeof msg.requestID !== 'string') {
        data.sentMessage.deferred.reject(error)
        return log('on migrate error')('msg', msg)
      }
      const req = ctx.state.requests.get(msg.requestID)
      if (!req) {
        data.sentMessage.deferred.reject(error)
        return log('on migrate error')('req', req)
      }
      req.options.dc = newDc
      log('migrate', 'req')(req)
      log('on migrate restart')('before end')
      await ctx.api.invokeNetRequest(req)
    } else if (isAuthRestart(error)) {
      if (!ctx.state.messages.has(data.message.req_msg_id)) {
        data.sentMessage.deferred.reject(error)
        return log('error', 'auth restart')(data.message.req_msg_id, 'req_msg_id not found')
      }
      const msg = ctx.state.messages.get(data.message.req_msg_id)
      if (!msg || !msg.requestID) {
        data.sentMessage.deferred.reject(error)
        return log('error', 'auth restart')('no requestID msg', msg)
      }
      const req = ctx.state.requests.get(msg.requestID)
      if (!req) {
        data.sentMessage.deferred.reject(error)
        return log('error', 'on auth restart')('no request info', msg)
      }
      const { authKey, saltKey } = dcStoreKeys(data.networkerDC)
      log('on auth restart')(authKey, saltKey)
      await ctx.storage.remove(authKey, saltKey)
      log('on auth restart')('before end')
      await ctx.api.invokeNetRequest(req)
    } else if (error.code === 401) {

      log('rpc', 'auth key unreg')(data.sentMessage)
      const reqId = data.sentMessage.requestID
      if (!reqId) {
        data.sentMessage.deferred.reject(error)
        return log('error', 'auth key unreg')('no requestID msg', data.sentMessage)
      }
      const dc = data.sentMessage.dc
      const req = ctx.state.requests.get(reqId)
      if (!req || !dc) {
        data.sentMessage.deferred.reject(error)
        return log('error', 'on auth key unreg')('no request info', dc, reqId)
      }

      const { authKey, saltKey } = dcStoreKeys(dc)
      // await ctx.storage.remove(authKey)
      const thread = ctx.state.threads.get(data.threadID)
      if (!thread) {
        data.sentMessage.deferred.reject(error)
        return log('error', 'on auth key unreg')('no thread', dc, data.threadID)
      }
      // thread.connectionInited = false
      ctx.api.authBegin = false
      log('on auth key unreg')('before end')
      const nearest = await ctx.storage.get('nearest_dc')
      await ctx.storage.set('dc', nearest)
      // await new Promise(rs => setTimeout(rs, 1e3))
      req.options.dc = nearest
      await ctx.api.doAuth()
      await ctx.api.invokeNetRequest(req)
    } else {
      log('rpc', 'unhandled')(data)
      data.sentMessage.deferred.reject(error)
    }
  })

  bus.netMessage.onValue((message) => {
    log('net message')(message)
    const req = ctx.state.messages.get(message.msg_id)
    log('req')(req)
  })

  bus.netMessage.onValue(log('new request'))

  bus.newRequest.observe(async (netReq) => {
    if (state.requests.has(netReq.requestID)) return log('request', 'repeat')(netReq)
    ctx.state.requests.set(netReq.requestID, netReq)
    let dc = netReq.options.dc
    if (!dc || dc === '@@home') {
      const fromStore = await ctx.storage.get('dc')
      dc = fromStore
        ? +fromStore
        : ctx.defaultDC
    }
    netReq.options.dc = dc

    log('request', 'new')(netReq)
    await new Promise(rs => setTimeout(rs, 100))
    ctx.api.invokeNetRequest(netReq)
  })

  bus.newSession.observe(async ({
    threadID,
    networkerDC,
    message,
    messageID
  }) => {
    const thread = ctx.state.threads.get(threadID)
    if (!thread) {
      log('new session', 'error', 'no thread')(threadID, messageID)
      return
    }
    await thread.applyServerSalt(message.server_salt)
    thread.ackMessage(messageID)
    thread.processMessageAck(message.first_msg_id)

    log('new session', 'handled')(messageID, networkerDC)
  })

  bus.noAuth.observe(async ({
    dc,
    req,
    apiReq,
    error
  }: NoAuth) => {
    const mainDc  = await ctx.storage.get('dc')
    if (dc === mainDc) {

    } else {

    }
  })

  return bus
}


const an: any = {}

const pushMessageCast    : PushMessageEvent = an
const responseRawCast    : RawEvent<Object> = an
const incomingMessageCast: IncomingMessageEvent = an
const newNetworkerCast   : NetworkerThread = an
const rpcResultCast      : OnRpcResult = an

const netMessageCast     : MtpCall = an
const newRequestCast     : ApiRequest = an
const messageInCast      : NetMessage = an
const newSessionCast     : OnNewSession = an
const baseCast           : BaseType = an
const noAuthCast         : NoAuth = an

function makeStreamMap(emitter: EventEmitterType) {
  const getter = makeEventStream(emitter)


  const pushMessage     = getter('push-message', pushMessageCast)
  const responseRaw     = getter('response-raw', responseRawCast)
  const incomingMessage = getter('incoming-message', incomingMessageCast)
  const newNetworker    = getter('new-networker', newNetworkerCast)
  const rpcError        = getter('rpc-error', changeRpcError)
  const rpcResult       = getter('rpc-result', rpcResultCast)
  const netMessage      = getter('net-message', netMessageCast)
  const newRequest      = getter('new-request', newRequestCast)
  const messageIn       = getter('message-in', messageInCast)
  const newSession      = getter('new-session', newSessionCast)
  const baseState       = getter('base', baseCast)
  const noAuth          = getter('no-auth', noAuthCast)

  const streamMap = {
    pushMessage,
    responseRaw,
    incomingMessage,
    newNetworker,
    rpcError,
    netMessage,
    newRequest,
    messageIn,
    rpcResult,
    newSession,
    noAuth,
    baseState: baseState.toProperty((): BaseType => 'INIT' )
  }

  return streamMap
}

type OnRpcResult = {
  threadID: string,
  networkerDC: number,
  message: { _: string, req_msg_id: string, [key: string]: any },
  sentMessage: NetMessage,
  result: Object
}


type OnRpcErrorRaw = {
  threadID: string,
  networkerDC: number,
  error: RpcRawError,
  sentMessage: NetMessage,
  message: { _: string, req_msg_id: string, [key: string]: any }
}

type OnRpcError = {
  threadID: string,
  networkerDC: number,
  error: RpcError,
  sentMessage: NetMessage,
  message: { _: string, req_msg_id: string, [key: string]: any }
}

type OnNewSession = {
  threadID: string,
  networkerDC: number,
  message: {
    _: string,
    req_msg_id: string,
    [key: string]: any
  },
  messageID: string
}

function changeRpcError({ error, ...raw }: OnRpcErrorRaw): OnRpcError {
  const changed = onRpcError(error)
  const result = { ...raw, error: changed }
  return result
}

type ApiCall = {
  type: 'api-call',
  msg_id: string,
  method: string,
  params: Object,
  options: {
    messageID?: string,
    dcID?: number
  }
}

type MtpCall = {
  type: 'mtp-call',
  msg_id: string,
  method: string,
  params: Object,
  options: Object
}

type PushMessageEvent = {
  threadID: string,
  message: NetMessage
}

type IncomingMessageEvent = {
  threadID: string,
  message: Object,
  messageID: string,
  sessionID: Uint8Array
}

type RawEvent<T> = {
  data: T,
  status: number,
  statusText: string
}

type NoAuth = {
  dc: number,
  req: Request,
  apiReq: ApiRequest,
  error: MTError,
}




export default createStreamBus