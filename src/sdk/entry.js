import EventEmitter from 'events';
import axios from 'axios';
import $ from 'jquery';
import defaultOptions from './options';
import { Connection, Ping, Message, buildMessage, upload, emotions } from './core/index';
import defaultStrophe, { Strophe, $msg, $iq, MD5 } from './core/strophe';
import messageHelper from './common/utils/messageHelper';
import utils, {
  configMix,
  createUUID,
  getCookie,
  dataURLtoFile
} from './common/utils/utils';
import sdkConfig from '../../sdk_config';

// eslint-disable-next-line
axios.interceptors.response.use(response => response, (error) => {
  // 对响应错误做点什么
  return Promise.resolve({
    data: {
      ret: false,
      errmsg: error.message
    }
  });
});

let readyCache = [];
let isReady = false;
const emptyFn = () => { };
// eslint-disable-next-line
const OBJ_RE = /\[obj type=\"(.*?)\" value=\"\[?(.*?)\]?\"( width=(.*?) height=(.*?))?.*?\]/g;

// 缓存历史消息
const cacheHistory = {
  // 请求状态
  loading: false
  // user(key): historyMsg(value)
  // ...
};

/**
 * sqk入口，给用户方提供公共的方法
 */
class QtalkSDK extends EventEmitter {
  // xmpp 方法
  static env = defaultStrophe;

  static defaultOptions = defaultOptions;

  static messageHelper = messageHelper;

  static $ = $;

  static emotions = emotions;

  // 静态方法
  static utils = utils;

  cacheChatInfo = {};

  constructor(options) {
    super();
    this.options = configMix(defaultOptions, options);

    // 调试可以输出错误
    if (this.options.debug) {
      Strophe.log = function log(level, msg) {
        if (level === this.LogLevel.FATAL &&
          typeof window.console === 'object' &&
          typeof window.console.error === 'function') {
          window.console.error(msg);
        }
      };
    }

    // 建立连接
    this.connection = new Connection(this.options.connect);

    this.ping = new Ping(this.connection.stropheConnection, this.options.pingInterval);
    this.message = new Message(this.connection.stropheConnection);

    this.message.on('ready', (key) => {
      this.key = key;
      isReady = true;
      readyCache.forEach((callback) => { callback(); });
      readyCache = [];

      // 写入ckey 到cookies
      const t = `${new Date().getTime()}`;
      //  t   = 1523851940847
      //  key = 619861523851940845287
      //  uid = darlyn
      const ckey = window.btoa(`u=${this.myId}&k=${MD5.hexdigest(`${key}${t}`).toUpperCase()}&t=${t}`);
      document.cookie = `q_ckey=${ckey}; domain=${this.options.xmpp}; path=/;`;//darlyn.com
    });

    // 连接成功
    this.connection
      .on('connect:success', (stropheConnection) => {
        const { jid } = stropheConnection;
        this.jid = jid;
        this.domain = Strophe.getDomainFromJid(jid);
        this.bareJid = Strophe.getBareJidFromJid(jid);
        this.myId = Strophe.getNodeFromJid(jid);
        this.ping.register();

        // 给服务器发送一条Presence 告诉服务器我准备好了，可以接收消息了
        this.message.registerHandler();
        this.message.sendPresence();
      })
      .on('connect:disconnected', () => {
        this.message.clearKey();
        this.key = '';
        isReady = false;
      });
  }

  ready(callback) {
    if (isReady) {
      callback();
    } else {
      readyCache.push(callback);
    }
  }

  /**
   * 发送消息
   * @param {String} 消息内容
   */
  async sendMessage(msg, msgType = '1', backupinfo) {
    const { bareJid, message, options } = this;
    const uuid = createUUID();
    const isGroup = message.currentSessionType === 'groupchat';
    const to = message.currentSessionId;
    const { maType } = options;
    const from = bareJid;
    const type = isGroup ? 'groupchat' : 'chat';
    // 编码
    if (msgType.toString() !== '5') {
      msg = messageHelper.encode(msg);
    }
    const uploadImg = imgdata => (
      new Promise((resolve) => {
        upload.image.call(this, emptyFn, (url) => {
          resolve(url);
        }, emptyFn, [dataURLtoFile(imgdata, createUUID())], true);
      })
    );
    const imgBase64Handler = async (content) => {
      const imgkey = [];
      const results = [];
      content = content.replace(OBJ_RE, (...args) => {
        if (args && args.length > 2) {
          const ret = args[0];
          const t = args[1];
          const imgdata = args[2];
          if (t === 'base64') {
            const tempid = createUUID();
            imgkey.push(tempid);
            results.push(uploadImg(imgdata));
            return `[obj type="image" value="--${tempid}--"]`;
          }
          return ret;
        }
        return args[0];
      });
      const allres = await Promise.all(results);
      imgkey.forEach((key, index) => {
        content = content.replace(`--${key}--`, allres[index]);
      });
      // for (let i = 0, len = imglist.length; i < len;) {
      //   const url = await uploadImg(imglist[i].val);
      //   content = content.replace(`--${imglist[i].key}--`, url);
      //   i += 1;
      // }
      return content;
    };
    // 如果有图片，则先上传图片
    msg = await imgBase64Handler(msg);
    message.send($msg({
      from,
      to,
      type,
      isHiddenMsg: '0'
    }).c('body', {
      backupinfo,
      msgType,
      maType,
      id: uuid
    }).t(msg).up()
      .c('active', {
        xmlns: Strophe.NS.CHATSTATES
      }));
    const bmsg = buildMessage({
      body: {
        content: msg,
        id: uuid,
        msgType
      },
      message: {
        type,
        sendjid: from
      },
      from: bareJid,
      muc: isGroup ? to : '',
      t: (new Date().getTime()) / 1000
    }, bareJid);
    return bmsg;
  }

  /**
   * 获取用户名片信息， 可以获取多个
   * @param {Array} data 获取用户卡片信息 ['用户1', ...]
   *
   * post过去格式:
   *  [
   *    {
   *      "domain": "ejabhost1",
   *      "users": [
   *        { user: 'darlyn', version: '0' }
   *      ]
   *    }
   *    ...
   * ]
   * version 固定传 0
   *
   * @returns { darlyn@domian: {}... }
   */
  async getUserCard(arr) {
    const data = [];
    // ejabhost1: [{user:'w', version: '0'}, ...]
    // ejabhost2: [{user:'w', version: '0'}, ...]
    const duser = {};
    arr.forEach((item) => {
      const domain = Strophe.getDomainFromJid(item);
      if (!duser[domain]) {
        duser[domain] = [];
      }
      duser[domain].push({
        user: Strophe.getNodeFromJid(item),
        version: '0'
      });
    });
    Object.keys(duser).forEach((key) => {
      data.push({
        domain: key,
        users: duser[key]
      });
    });
    const req = await axios({
      method: 'post',
      url: '/newapi/domain/get_vcard_info.qunar',
      headers: { 'Content-Type': 'application/json' },
      params: {
        u: this.myId,
        k: this.key
      },
      data: JSON.stringify(data)
    });
    const ret = {};
    if (req.data.ret) {
      req.data.data.forEach((p) => {
        const { domain } = p;
        p.users.forEach((u) => {
          ret[`${u.username}@${domain}`] = u;
        });
      });
      req.data.data = ret;
      this.cacheChatInfo = Object.assign({}, this.cacheChatInfo, ret);
    }
    return req.data;
  }

  /**
   * 获取直属领导，员工编号
   * @param {String} 登录名 => darlyn
   */
  async getUserLeader(user) {
    const data = {
      platform: 'web',
      qtalk_id: user,
      user_id: user,
      ckey: getCookie('q_ckey')
    };
    const req = await axios({
      method: 'post',
      url: '/package/ops/opsapp/api/info',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(data)
    });
    req.data.ret = true;
    if (req.data.errcode !== 0) {
      req.data.ret = false;
    }
    return req.data;
  }

  /**
   * 查询用户电话
   * @param {String} 登录名 => darlyn
   */
  async getUserPhone(user) {
    const data = {
      platform: 'web',
      qtalk_id: user,
      user_id: user,
      ckey: getCookie('q_ckey')
    };
    const req = await axios({
      method: 'post',
      url: '/package/ops/opsapp/api/mobile-phone',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(data)
    });
    req.data.ret = true;
    if (req.data.errcode !== 0) {
      req.data.ret = false;
    }
    return req.data;
  }

  /**
   * 获取用户个性签名
   * @param {String} 登录名 => darlyn@domain
   */
  async getUserProfile(user) {
    const { myId, key } = this;
    const { getNodeFromJid, getDomainFromJid } = Strophe;
    const data = [{
      version: '0',
      user: getNodeFromJid(user),
      domain: getDomainFromJid(user)
    }];
    const req = await axios({
      method: 'post',
      url: '/api/get_user_profile',
      headers: { 'Content-Type': 'application/json' },
      params: {
        u: myId,
        k: key,
        p: 'web',
        v: 0
      },
      data: JSON.stringify(data)
    });
    return req.data;
  }

  /**
   * 更新用户个性签名
   */
  async setUserProfile(desc) {
    const { myId, key, domain } = this;
    const data = {
      mood: desc,
      user: myId,
      domain
    };
    const req = await axios({
      method: 'post',
      url: '/api/set_user_profile',
      headers: { 'Content-Type': 'application/json' },
      params: {
        u: myId,
        k: key
      },
      data: JSON.stringify(data)
    });
    return req.data;
  }

  /**
   * 获取群名片
   */
  async getGroupCard(arr) {
    const data = [];
    const duser = {};
    arr.forEach((item) => {
      const domain = Strophe.getDomainFromJid(item);
      if (!duser[domain]) {
        duser[domain] = [];
      }
      duser[domain].push({
        muc_name: item,
        version: '0'
      });
    });
    Object.keys(duser).forEach((key) => {
      data.push({
        domain: key,
        mucs: duser[key]
      });
    });
    const req = await axios({
      method: 'post',
      url: '/newapi/muc/get_muc_vcard.qunar',
      headers: { 'Content-Type': 'application/json' },
      params: {
        u: this.myId,
        k: this.key
      },
      data: JSON.stringify(data)
    });
    const ret = {};
    if (req.data.ret) {
      req.data.data.forEach((p) => {
        p.mucs.forEach((u) => {
          ret[u.MN] = u;
        });
      });
      req.data.data = ret;
      this.cacheChatInfo = Object.assign({}, this.cacheChatInfo, ret);
    }
    return req.data;
  }

  /**
   * 获取会话列表
   */
  async getSessionList() {
    const { domain, myId } = this;
    const data = {
      domain,
      user: myId
    };
    const ret = await axios({
      method: 'post',
      url: '/package/qtapi/getrbl.qunar',//.darlyn
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(data)
    });
    let topsInfo = await this.getTopInfo();
    if (topsInfo.ret) {
      topsInfo = topsInfo.data;
    } else {
      topsInfo = {};
    }
    const res = ret.data;
    if (res.ret) {
      res.data = res.data.map((item) => {
        const $xml = $($.parseXML(item.xmlBody));
        const $message = $xml.find('message');
        const $body = $message.find('body');
        const msgType = $body.attr('msgType');
        const msg = $body.text();
        // 单聊 user 里面不包含域， 所以要从 from 里面去取
        let user = Strophe.getBareJidFromJid(item.user);
        if (item.mFlag === '1') {
          // 单聊没有返回domain，所以补上 ejabhost1
          user = `${user}@${item.host}`;
        }
        return Object.assign({}, item, {
          sdk_msg: messageHelper.filter(msg, msgType),
          user,
          msgType,
          backupinfo: $body.attr('backupinfo'),
          isTop: !!topsInfo[user]
        });
      });
    }
    return res;
  }

  /**
   * 获取单人历史消息
   */
  async getHistoryMsg(to, pageSize = 20, isFirst) {
    const { domain, myId, bareJid } = this;
    this.message.currentSessionId = to;
    this.message.currentSessionType = 'chat';
    if (cacheHistory.loading) {
      return {
        ret: false,
        errmsg: 'request_loading'
      };
    }
    cacheHistory.loading = true;
    // 读取缓存
    const time = new Date().getTime() / 1000;
    if (!cacheHistory[to] || isFirst) {
      cacheHistory[to] = {
        time,
        haveOther: false
      };
    }
    const ret = await axios({
      method: 'post',
      url: '/package/qtapi/getmsgs.qunar',//.darlyn
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({
        from: myId,
        to: Strophe.getNodeFromJid(to),
        direction: '0',
        time: cacheHistory[to].time,
        domain,
        num: pageSize,
        fhost: domain,
        thost: Strophe.getDomainFromJid(to),
        f: 't'
      })
    });
    const res = ret.data;
    const unReadMsg = [];
    if (res.ret) {
      cacheHistory[to].haveOther = res.data.length === pageSize;
      const msgs = [];
      res.data.forEach((item, index) => {
        const isRead = Math.floor(item.read_flag / 2) % 2 === 1;
        item.from = `${item.from}@${item.from_host}`;
        item.to = `${item.to}@${item.to_host}`;
        msgs.push(buildMessage(item, bareJid));
        if (index === 0) {
          const stamp = item.t * 1000;
          cacheHistory[to].time = stamp;
        }
        if (!isRead) {
          unReadMsg.push(item.body.id);
        }
      });
      res.data = {
        msgs,
        haveOther: cacheHistory[to].haveOther
      };
      if (unReadMsg.length > 0) {
        this.message.messageAlreadyRead(true, {
          from: bareJid,
          to: `${to}`
        }, unReadMsg);
      }
    }
    cacheHistory.loading = false;
    return res;
  }

  /**
   * 获取群历史消息
   */
  async getGroupHistoryMsg(muc, pageSize = 20, isFirst) {
    const { domain, bareJid } = this;
    this.message.currentSessionId = muc;
    this.message.currentSessionType = 'groupchat';
    if (cacheHistory.loading) {
      return {
        ret: false,
        errmsg: 'request_loading'
      };
    }
    cacheHistory.loading = true;
    // 读取缓存
    const time = new Date().getTime() / 1000;
    if (!cacheHistory[muc] || isFirst) {
      cacheHistory[muc] = {
        time,
        haveOther: false
      };
    }
    const ret = await axios({
      method: 'post',
      url: '/package/qtapi/getmucmsgs.qunar',//.darlyn
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({
        muc: Strophe.getNodeFromJid(muc),
        direction: '0',
        time: cacheHistory[muc].time,
        domain,
        num: pageSize
      })
    });
    const res = ret.data;
    if (res.ret) {
      cacheHistory[muc].haveOther = res.data.length === pageSize;
      const msgs = [];
      res.data.forEach((item, index) => {
        msgs.push(buildMessage(item, bareJid));
        if (index === 0) {
          const stamp = item.t * 1000;
          cacheHistory[muc].time = stamp;
        }
      });
      res.data = {
        msgs,
        haveOther: cacheHistory[muc].haveOther
      };
      this.message.messageAlreadyRead(false, {
        from: bareJid,
        to: muc
      });
    }
    cacheHistory.loading = false;
    return res;
  }

  uploadImg({
    type = 'image',
    before = emptyFn,
    success = emptyFn,
    progress = emptyFn,
    filesList = [],
    onlyUrl
  }) {
    return upload[type].call(this, before, success, progress, filesList, onlyUrl);
  }

  /**
   * 获取群成员
   */
  getGroupUserList(muc) {
    // <iq to='darlyn@darlyn'
    // id='console938df079' type='get'>
    // <query xmlns=''/>
    // </iq>
    return new Promise((resolve) => {
      const id = createUUID();
      // addHandler (handler, ns, name, type, id, from, options)
      const handler = this.message.addTemplateHandler((iq) => {
        this.message.deleteTemplateHandler(handler);
        const $users = $(iq).find('m_user');
        const ret = [];
        $users.each((index, item) => {
          ret.push({
            jid: $(item).attr('jid'),
            affiliation: $(item).attr('affiliation')
          });
        });
        resolve({
          data: ret,
          ret: true
        });
        return true;
      }, null, 'iq', 'result', id);
      this.message.send($iq({
        id,
        to: muc,
        type: 'get'
      }).c('query', { xmlns: 'http://jabber.org/protocol/muc#register' }));
    });
  }

  /**
   * 添加群成员，如果当前会话是个人，则先创建群，在拉人
   * users  [{jid,nick}...]
   */
  addUser(users, newGroup) {
    // <iq to='darlyn@darlyn.darlyn' id='' type='set'>
    //     <query xmlns='http://jabber.org/protocol/muc#invite_v2'>
    //         <invite jid='darlyn@darlyn.darlyn' nick='斯坦索姆'/>
    //         <invite jid='darlyn@darlyn.darlyn' nick='奥格瑞玛'/>
    //         <invite jid='darlyn@darlyn.darlyn'nick='冰冠城塞'/>
    //     </query>
    // </iq>
    let { currentSessionId } = this.message;
    const { currentSessionType } = this.message;
    return new Promise((resolve, reject) => {
      const id = createUUID();
      const add = () => {
        // 拉人
        const iq = $iq({
          id,
          to: currentSessionId,
          type: 'set'
        }).c('query', { xmlns: 'http://jabber.org/protocol/muc#invite_v2' });
        users.forEach((u) => {
          iq.c('invite', u).up();
        });
        this.message.send(iq);
        resolve({ ret: true, data: currentSessionId.toLowerCase() });
      };
      // 单聊先要建群
      if (newGroup || currentSessionType === 'chat') {
        currentSessionId = `${id}@conference.${sdkConfig.domain}`;
        // addHandler (handler, ns, name, type, id, from, options)
        const handler = this.message.addTemplateHandler((iq) => {
          this.message.deleteTemplateHandler(handler);
          const state = $(iq).find('create_muc').attr('result');
          if (state === 'success') {
            // 更新群名片
            this.updateMucCard([{
              muc_name: currentSessionId.toLowerCase(),
              nick: users.slice(0, 5).map(u => u.nick).join(',')
            }]);
            add();
          } else {
            reject({
              ret: false,
              errmsg: '创建群失败'
            });
          }
          return true;
        }, null, 'iq', 'result', id);
        // <iq to='darlyn@darlyn.darlyn' id='' type='set'>
        //     <query xmlns=''/>
        // </iq>
        this.message.send($iq({
          id,
          to: currentSessionId,
          type: 'set'
        }).c('query', { xmlns: 'http://jabber.org/protocol/create_muc' }));
      } else {
        add();
      }
    });
  }

  /**
   * 获取组织架构
   */
  async getCompanyStruct() {
    const { myId, key } = this;
    // const req = await axios.get('/api/getdeps', {
    //   params: {
    //     u: myId,
    //     k: key
    //   }
    // });
    const req = await axios.post('/newapi/update/getUpdateUsers.qunar', {
      params: {
        q_ckey: getCookie('q_ckey'),
        version: 0//全量
      }
    });
    return {
      ret: true,
      data: req.data
    };
  }

  /**
   * 更新群名片
   * [{ "muc_name": "test123", "nick": "test_hh123", "desc": "12fff3" }, ...]
   */
  async updateMucCard(data) {
    const { key, myId } = this;
    const ret = await axios({
      method: 'post',
      url: '/api/setmucvcard',
      headers: { 'Content-Type': 'application/json' },
      params: {
        u: myId,
        k: key
      },
      data: JSON.stringify(data)
    });
    const res = ret.data;
    return res;
  }

  /**
   * [查询用户和群组]
   * @param  {[type]}
   * data {
   *  start: 0,
   *  length: 5,
   *  key: val,
   *  qtalkId: sdk.myId,
   *  cKey: this.getCookie('q_ckey')
   * }
   * @return {Promise}      [description]
   * TODO
   */
  async searchUser(data) {
    const ret = await axios({
      method: 'post',
      url: '/search/search.py',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(data)
    });
    const res = ret.data;
    return res;
  }

  /**
   * 获取置顶信息
   * darlyn.com/conf/get_person?
   *  server=test
   *  c=qtalk
   *  u=darlyn
   *  k=123
   *  p=web
   *  d=test
   */
  async getTopInfo() {
    const { myId, key, domain } = this;
    // const req = await axios({
    //   method: 'post',
    //   url: '/api/conf/get_person',
    //   headers: { 'Content-Type': 'application/json' },
    //   params: {
    //     u: myId,
    //     k: key,
    //     p: 'web',
    //     d: domain,
    //     server: domain,
    //     c: 'qtalk'
    //   },
    //   data: JSON.stringify([{
    //     key: 'kStickJidDic',
    //     version: '0'
    //   }])
    // });
    const req = await axios({
      method: 'post',
      url: '/newapi/configuration/getincreclientconfig.qunar',
      headers: { 'Content-Type': 'application/json' },
      // params: {
      //   username: myId,
      //   host: domain,
      //   version: 0,
      // },
      data: JSON.stringify({
        username: myId,
        host: domain,
        version: 0
      })
    });
    const res = req.data;
    const ret = {
      ret: true
    };
    if (res.ret) {
      ret.data = JSON.parse((res.data[0] || {}).value || '{}');
    } else {
      ret.ret = false;
    }
    return ret;
  }

  /**
   * 设置置顶
   * darlyn.com/conf/set_person?
   *  server=ejabhost1
   *  c=qtalk
   *  u=darlyn
   *  k=123
   *  p=web
   *  d=ejabhost1
   *
   * @param {Object} id   { 'darlyn@domain': true,...}
   */
  async setTopInfo(ids) {
    const { myId, key, domain } = this;
    let tops = await this.getTopInfo();
    if (tops.ret) {
      tops = tops.data;
    } else {
      tops = {};
    }
    Object.keys(ids).forEach((k) => {
      if (ids[k]) {
        tops[k] = true;
      } else {
        delete tops[k];
      }
    });
    const req = await axios({
      method: 'post',
      url: '/api/conf/set_person',
      headers: { 'Content-Type': 'application/json' },
      params: {
        u: myId,
        k: key,
        p: 'web',
        d: domain,
        server: domain,
        c: 'qtalk'
      },
      data: JSON.stringify([{
        key: 'kStickJidDic',
        value: JSON.stringify(tops),
        d: domain
      }])
    });
    return req.data;
  }

  /**
   * [群列表]
   * darlyn.com/get_increment_mucs?u=appstore&k=29071152567144457386
   * 接口Body参数： {"u":"appstore","t":0,"d":"ejabhost1"}
   */
  async getIncrementMucs() {
    const { myId, key, domain } = this;
    const req = await axios({
      method: 'post',
      url: '/newapi/muc/get_increment_mucs.qunar',
      headers: { 'Content-Type': 'application/json' },
      params: {
        u: myId,
        k: key
      },
      data: {
        u: myId,
        d: domain,
        t: 0
      }
    });
    return req.data;
  }

  /**
   * [获取好友列表]
   * @return {[type]} [description]
   * TODO
   */
  getUserFriends() {
    // <iq
    //   from="lffan.liu@ejabhost1"
    //   id="qxmpp10"
    //   type="get"
    // >
    //   <get_user_friends xmlns="jabber:x:get_friend"/>
    // </iq>
    return new Promise((resolve) => {
      const id = createUUID();
      // addHandler (handler, ns, name, type, id, from, options)
      const handler = this.message.addTemplateHandler((iq) => {
        this.message.deleteTemplateHandler(handler);
        const $friends = $(iq).find('get_user_friends');
        const fStr = $friends.attr('friends');
        let friends = [];
        if (fStr) {
          try {
            friends = JSON.parse(fStr);
          } catch (e) {
            friends = [];
          }
        }
        resolve({
          data: friends,
          ret: true
        });
        return true;
      }, null, 'iq', 'result', id);
      this.message.send($iq({
        id,
        from: this.bareJid,
        type: 'get'
      }).c('get_user_friends', { xmlns: 'jabber:x:get_friend' }));
    });
  }

  /**
   * 获取域列表
   * @return {Promise} [description]
   * TODO
   */
  async getDomainList() {
    const ret = await axios({
      method: 'post',
      url: '/package/s/qtalk/domainlist.php?t=qtalk',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({
        version: 0
      })
    });
    const res = ret.data;
    return res;
  }

  /**
   * [搜索好友]
   * @param  {[type]}
   * data {
   *  id: "qtalk.com",
   *  key: "weidongxu.xu",
   *  cKey: this.getCookie('q_ckey'),
   *  limit: 12,
   *  offset: 0
   * }
   * @return {Promise}      [description]
   * TODO
   */

  async searchSbuddy(data) {
    const ret = await axios({
      method: 'post',
      url: '/package/s/qtalk/sbuddy.php',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(data)
    });
    const res = ret.data;
    return res;
  }
  /**
   * 退出群
   * @param {String} groupId  asdaf@domian
   */
  groupExit(groupId) {
    const { bareJid, message } = this;
    const id = createUUID();
    message.send($iq({
      id,
      from: bareJid,
      to: groupId,
      type: 'set'
    }).c('query', { xmlns: 'http://jabber.org/protocol/muc#del_register' }));
  }

  /**
   * 群销毁
   * @param {String} groupId  asdaf@domian
   */
  groupDistory(groupId) {
    const { bareJid, message } = this;
    const id = createUUID();
    message.send($iq({
      id,
      from: bareJid,
      to: groupId,
      type: 'set'
    }).c('query', { xmlns: 'http://jabber.org/protocol/muc#owner' })
      .c('destroy', null));
  }

  /**
   * 提升未管理员
   */
  groupSetAdmin(user, groupId, flag) {
    const { bareJid, message } = this;
    const id = createUUID();
    message.send($iq({
      id,
      from: bareJid,
      to: groupId,
      type: 'set'
    }).c('query', { xmlns: 'http://jabber.org/protocol/muc#admin' })
      .c('item', { real_jid: user, nick: Strophe.getNodeFromJid(user), affiliation: flag ? 'admin' : 'member' }));
  }

  /**
   * 移除用户出群组
   */
  groupRemoveUser(user, groupId) {
    const { bareJid, message } = this;
    const id = createUUID();
    message.send($iq({
      id,
      from: bareJid,
      to: groupId,
      type: 'set'
    }).c('query', { xmlns: 'http://jabber.org/protocol/muc#admin' })
      .c('item', { real_jid: user, nick: Strophe.getNodeFromJid(user), role: 'none' }));
  }

  /**
   * 撤销信息
   */
  revokeMsg(id, to) {
    const { bareJid, message } = this;
    message.send($msg({
      chatid: '0',
      from: bareJid,
      to,
      type: 'revoke'
    }).c('body', { msgType: '-1', id, maType: '3' })
      .t(JSON.stringify({
        fromId: bareJid,
        message: 'revoke a message',
        messageId: id
      })));
  }

  // darlyn/get_user_status?v=10121100&p=qim_windows&u=lffan.liu&k=619861526283933141778&d=ejabhost1
  // data : [{"domain":"ejabhost1","users":["huajun.liu","ping.xue","test"]}]
  async onLineStatus(data) {
    const { myId, key, domain } = this;
    const ret = await axios({
      method: 'post',
      url:'/newapi/domain/get_user_status.qunar?v=10121100',
      headers: { 'Content-Type': 'application/json' },
      params: {
        u: myId,
        k: key,
        p: 'web',
        d: domain,
        v: 0
      },
      data: JSON.stringify(data)
    });
    const res = ret.data;
    return res;
  }
}

// 挂载全局变量
window.QtalkSDK = QtalkSDK;
export default QtalkSDK;
