"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _moment = _interopRequireDefault(require("moment"));
var _debug = require("../helpers/debug");
var _elementsInteractions = require("../helpers/elements-interactions");
var _fetch = require("../helpers/fetch");
var _navigation = require("../helpers/navigation");
var _storage = require("../helpers/storage");
var _transactions = require("../helpers/transactions");
var _waiting = require("../helpers/waiting");
var _transactions2 = require("../transactions");
var _baseScraperWithBrowser = require("./base-scraper-with-browser");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
const apiHeaders = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  Origin: 'https://digital-web.cal-online.co.il',
  Referer: 'https://digital-web.cal-online.co.il',
  'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
  'Sec-Fetch-Site': 'same-site',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty'
};
const LOGIN_URL = 'https://www.cal-online.co.il/';
const TRANSACTIONS_REQUEST_ENDPOINT = 'https://api.cal-online.co.il/Transactions/api/transactionsDetails/getCardTransactionsDetails';
const FRAMES_REQUEST_ENDPOINT = 'https://api.cal-online.co.il/Frames/api/Frames/GetFrameStatus';
const PENDING_TRANSACTIONS_REQUEST_ENDPOINT = 'https://api.cal-online.co.il/Transactions/api/approvals/getClearanceRequests';
const SSO_AUTHORIZATION_REQUEST_ENDPOINT = 'https://connect.cal-online.co.il/col-rest/calconnect/authentication/SSO';
const InvalidPasswordMessage = 'שם המשתמש או הסיסמה שהוזנו שגויים';
const ChangePasswordMessage = 'להחליף סיסמה';
const debug = (0, _debug.getDebug)('visa-cal');
var TrnTypeCode = /*#__PURE__*/function (TrnTypeCode) {
  TrnTypeCode["regular"] = "5";
  TrnTypeCode["credit"] = "6";
  TrnTypeCode["installments"] = "8";
  TrnTypeCode["standingOrder"] = "9";
  return TrnTypeCode;
}(TrnTypeCode || {});
function isAuthModule(result) {
  return Boolean(result?.auth?.calConnectToken && String(result.auth.calConnectToken).trim());
}
function authModuleOrUndefined(result) {
  return isAuthModule(result) ? result : undefined;
}
function isPending(transaction) {
  return transaction.debCrdDate === undefined; // an arbitrary field that only appears in a completed transaction
}
function isCardTransactionDetails(result) {
  return result.result !== undefined;
}
function isCardPendingTransactionDetails(result) {
  return result.result !== undefined;
}
async function getLoginFrame(page) {
  let frame = null;
  debug('wait until login frame found');
  await (0, _waiting.waitUntil)(() => {
    frame = page.frames().find(f => f.url().includes('connect')) || null;
    return Promise.resolve(!!frame);
  }, 'wait for iframe with login form', 10000, 1000);
  if (!frame) {
    debug('failed to find login frame for 10 seconds');
    throw new Error('failed to extract login iframe');
  }
  return frame;
}
async function hasInvalidPasswordError(page) {
  const frame = await getLoginFrame(page);
  const errorFound = await (0, _elementsInteractions.elementPresentOnPage)(frame, 'div.general-error > div');
  const errorMessage = errorFound ? await (0, _elementsInteractions.pageEval)(frame, 'div.general-error > div', '', item => {
    return item.innerText;
  }) : '';
  return errorMessage === InvalidPasswordMessage;
}
async function hasChangePasswordForm(page) {
  const frame = await getLoginFrame(page);
  // "כדי להחליף סיסמה יש ללחוץ על 'שכחתי שם משתמש / סיסמה' במסך הכניסה"
  const errorFound = await (0, _elementsInteractions.elementPresentOnPage)(frame, '.err-desc');
  if (errorFound) {
    const errText = await (0, _elementsInteractions.pageEval)(frame, '.err-desc', '', item => {
      return item.innerText.trim();
    });
    return errText.includes(ChangePasswordMessage);
  }
  return false;
}
function getPossibleLoginResults() {
  debug('return possible login results');
  const urls = {
    [_baseScraperWithBrowser.LoginResults.Success]: [/dashboard/i],
    [_baseScraperWithBrowser.LoginResults.InvalidPassword]: [async options => {
      const page = options?.page;
      if (!page) {
        return false;
      }
      return hasInvalidPasswordError(page);
    }],
    // [LoginResults.AccountBlocked]: [], // TODO add when reaching this scenario
    [_baseScraperWithBrowser.LoginResults.ChangePassword]: [async options => {
      const page = options?.page;
      if (!page) {
        return false;
      }
      return hasChangePasswordForm(page);
    }]
  };
  return urls;
}
function createLoginFields(credentials) {
  debug('create login fields for username and password');
  return [{
    selector: '[formcontrolname="userName"]',
    value: credentials.username
  }, {
    selector: '[formcontrolname="password"]',
    value: credentials.password
  }];
}
function convertParsedDataToTransactions(data, pendingData, options) {
  const pendingTransactions = pendingData?.result ? pendingData.result.cardsList.flatMap(card => card.authDetalisList) : [];
  const bankAccounts = data.flatMap(monthData => monthData.result.bankAccounts);
  const regularDebitDays = bankAccounts.flatMap(accounts => accounts.debitDates);
  const immediateDebitDays = bankAccounts.flatMap(accounts => accounts.immidiateDebits.debitDays);
  const completedTransactions = [...regularDebitDays, ...immediateDebitDays].flatMap(debitDate => debitDate.transactions);
  const all = [...pendingTransactions, ...completedTransactions];
  return all.map(transaction => {
    const numOfPayments = isPending(transaction) ? transaction.numberOfPayments : transaction.numOfPayments;
    const installments = numOfPayments ? {
      number: isPending(transaction) ? 1 : transaction.curPaymentNum,
      total: numOfPayments
    } : undefined;
    const date = (0, _moment.default)(transaction.trnPurchaseDate);
    const chargedAmount = (isPending(transaction) ? transaction.trnAmt : transaction.amtBeforeConvAndIndex) * -1;
    const originalAmount = transaction.trnAmt * (transaction.trnTypeCode === TrnTypeCode.credit ? 1 : -1);
    const result = {
      identifier: !isPending(transaction) ? transaction.trnIntId : undefined,
      type: [TrnTypeCode.regular, TrnTypeCode.standingOrder].includes(transaction.trnTypeCode) ? _transactions2.TransactionTypes.Normal : _transactions2.TransactionTypes.Installments,
      status: isPending(transaction) ? _transactions2.TransactionStatuses.Pending : _transactions2.TransactionStatuses.Completed,
      date: installments ? date.add(installments.number - 1, 'month').toISOString() : date.toISOString(),
      processedDate: isPending(transaction) ? date.toISOString() : new Date(transaction.debCrdDate).toISOString(),
      originalAmount,
      originalCurrency: transaction.trnCurrencySymbol,
      chargedAmount,
      chargedCurrency: !isPending(transaction) ? transaction.debCrdCurrencySymbol : undefined,
      description: transaction.merchantName,
      memo: transaction.transTypeCommentDetails.toString(),
      category: transaction.branchCodeDesc
    };
    if (installments) {
      result.installments = installments;
    }
    if (options?.includeRawTransaction) {
      result.rawTransaction = (0, _transactions.getRawTransaction)(transaction);
    }
    return result;
  });
}
class VisaCalScraper extends _baseScraperWithBrowser.BaseScraperWithBrowser {
  authorization = undefined;
  openLoginPopup = async () => {
    debug('open login popup, wait until login button available');
    await (0, _elementsInteractions.waitUntilElementFound)(this.page, '#ccLoginDesktopBtn', true);
    debug('click on the login button');
    await (0, _elementsInteractions.clickButton)(this.page, '#ccLoginDesktopBtn');
    debug('get the frame that holds the login');
    const frame = await getLoginFrame(this.page);
    debug('wait until the password login tab header is available');
    await (0, _elementsInteractions.waitUntilElementFound)(frame, '#regular-login');
    debug('navigate to the password login tab');
    await (0, _elementsInteractions.clickButton)(frame, '#regular-login');
    debug('wait until the password login tab is active');
    await (0, _elementsInteractions.waitUntilElementFound)(frame, 'regular-login');
    return frame;
  };
  async getCards() {
    const initData = await (0, _waiting.waitUntil)(() => (0, _storage.getFromSessionStorage)(this.page, 'init'), 'get init data in session storage', 10000, 1000);
    if (!initData) {
      throw new Error('could not find "init" data in session storage');
    }
    return initData?.result.cards.map(({
      cardUniqueId,
      last4Digits
    }) => ({
      cardUniqueId,
      last4Digits
    }));
  }
  async getAuthorizationHeader() {
    if (!this.authorization) {
      debug('fetching authorization header');
      const authModule = await (0, _waiting.waitUntil)(async () => authModuleOrUndefined(await (0, _storage.getFromSessionStorage)(this.page, 'auth-module')), 'get authorization header with valid token in session storage', 10_000, 50);
      return `CALAuthScheme ${authModule.auth.calConnectToken}`;
    }
    return this.authorization;
  }
  async getXSiteId() {
    /*
      I don't know if the constant below will change in the feature.
      If so, use the next code:
       return this.page.evaluate(() => new Ut().xSiteId);
       To get the classname search for 'xSiteId' in the page source
      class Ut {
        constructor(_e, on, yn) {
            this.store = _e,
            this.config = on,
            this.eventBusService = yn,
            this.xSiteId = "09031987-273E-2311-906C-8AF85B17C8D9",
    */
    return Promise.resolve('09031987-273E-2311-906C-8AF85B17C8D9');
  }
  getLoginOptions(credentials) {
    this.authRequestPromise = this.page.waitForRequest(SSO_AUTHORIZATION_REQUEST_ENDPOINT, {
      timeout: 10_000
    }).catch(e => {
      debug('error while waiting for the token request', e);
      return undefined;
    });
    return {
      loginUrl: `${LOGIN_URL}`,
      fields: createLoginFields(credentials),
      submitButtonSelector: 'button[type="submit"]',
      possibleResults: getPossibleLoginResults(),
      checkReadiness: async () => (0, _elementsInteractions.waitUntilElementFound)(this.page, '#ccLoginDesktopBtn'),
      preAction: this.openLoginPopup,
      postAction: async () => {
        try {
          await (0, _navigation.waitForNavigation)(this.page);
          const currentUrl = await (0, _navigation.getCurrentUrl)(this.page);
          if (currentUrl.endsWith('site-tutorial')) {
            await (0, _elementsInteractions.clickButton)(this.page, 'button.btn-close');
          }
          const request = await this.authRequestPromise;
          this.authorization = String(request?.headers().authorization || '').trim();
        } catch (e) {
          const currentUrl = await (0, _navigation.getCurrentUrl)(this.page);
          if (currentUrl.endsWith('dashboard')) return;
          const requiresChangePassword = await hasChangePasswordForm(this.page);
          if (requiresChangePassword) return;
          throw e;
        }
      },
      userAgent: apiHeaders['User-Agent']
    };
  }
  async fetchData() {
    const defaultStartMoment = (0, _moment.default)().subtract(1, 'years').subtract(6, 'months').add(1, 'day');
    const startDate = this.options.startDate || defaultStartMoment.toDate();
    const startMoment = _moment.default.max(defaultStartMoment, (0, _moment.default)(startDate));
    debug(`fetch transactions starting ${startMoment.format()}`);
    const [cards, xSiteId, Authorization] = await Promise.all([this.getCards(), this.getXSiteId(), this.getAuthorizationHeader()]);
    const futureMonthsToScrape = this.options.futureMonthsToScrape ?? 1;
    debug('fetch frames (misgarot) of cards');
    const frames = await (0, _fetch.fetchPost)(FRAMES_REQUEST_ENDPOINT, {
      cardsForFrameData: cards.map(({
        cardUniqueId
      }) => ({
        cardUniqueId
      }))
    }, {
      Authorization,
      'X-Site-Id': xSiteId,
      'Content-Type': 'application/json',
      ...apiHeaders
    });
    const accounts = await Promise.all(cards.map(async card => {
      const finalMonthToFetchMoment = (0, _moment.default)().add(futureMonthsToScrape, 'month');
      const months = finalMonthToFetchMoment.diff(startMoment, 'months');
      const allMonthsData = [];
      const frame = frames.result?.bankIssuedCards?.cardLevelFrames?.find(f => f.cardUniqueId === card.cardUniqueId);
      debug(`fetch pending transactions for card ${card.cardUniqueId}`);
      let pendingData = await (0, _fetch.fetchPost)(PENDING_TRANSACTIONS_REQUEST_ENDPOINT, {
        cardUniqueIDArray: [card.cardUniqueId]
      }, {
        Authorization,
        'X-Site-Id': xSiteId,
        'Content-Type': 'application/json',
        ...apiHeaders
      });
      debug(`fetch completed transactions for card ${card.cardUniqueId}`);
      for (let i = 0; i <= months; i++) {
        const month = finalMonthToFetchMoment.clone().subtract(i, 'months');
        const monthData = await (0, _fetch.fetchPost)(TRANSACTIONS_REQUEST_ENDPOINT, {
          cardUniqueId: card.cardUniqueId,
          month: month.format('M'),
          year: month.format('YYYY')
        }, {
          Authorization,
          'X-Site-Id': xSiteId,
          'Content-Type': 'application/json',
          ...apiHeaders
        });
        if (monthData?.statusCode !== 1) throw new Error(`failed to fetch transactions for card ${card.last4Digits}. Message: ${monthData?.title || ''}`);
        if (!isCardTransactionDetails(monthData)) {
          throw new Error('monthData is not of type CardTransactionDetails');
        }
        allMonthsData.push(monthData);
      }
      if (pendingData?.statusCode !== 1 && pendingData?.statusCode !== 96) {
        debug(`failed to fetch pending transactions for card ${card.last4Digits}. Message: ${pendingData?.title || ''}`);
        pendingData = null;
      } else if (!isCardPendingTransactionDetails(pendingData)) {
        debug('pendingData is not of type CardTransactionDetails');
        pendingData = null;
      }
      const transactions = convertParsedDataToTransactions(allMonthsData, pendingData, this.options);
      debug('filter out old transactions');
      const txns = this.options.outputData?.enableTransactionsFilterByDate ?? true ? (0, _transactions.filterOldTransactions)(transactions, (0, _moment.default)(startDate), this.options.combineInstallments || false) : transactions;
      return {
        txns,
        balance: frame?.nextTotalDebit != null ? -frame.nextTotalDebit : undefined,
        accountNumber: card.last4Digits
      };
    }));
    debug('return the scraped accounts');
    debug(JSON.stringify(accounts, null, 2));
    return {
      success: true,
      accounts
    };
  }
}
var _default = exports.default = VisaCalScraper;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbW9tZW50IiwiX2ludGVyb3BSZXF1aXJlRGVmYXVsdCIsInJlcXVpcmUiLCJfZGVidWciLCJfZWxlbWVudHNJbnRlcmFjdGlvbnMiLCJfZmV0Y2giLCJfbmF2aWdhdGlvbiIsIl9zdG9yYWdlIiwiX3RyYW5zYWN0aW9ucyIsIl93YWl0aW5nIiwiX3RyYW5zYWN0aW9uczIiLCJfYmFzZVNjcmFwZXJXaXRoQnJvd3NlciIsImUiLCJfX2VzTW9kdWxlIiwiZGVmYXVsdCIsImFwaUhlYWRlcnMiLCJPcmlnaW4iLCJSZWZlcmVyIiwiTE9HSU5fVVJMIiwiVFJBTlNBQ1RJT05TX1JFUVVFU1RfRU5EUE9JTlQiLCJGUkFNRVNfUkVRVUVTVF9FTkRQT0lOVCIsIlBFTkRJTkdfVFJBTlNBQ1RJT05TX1JFUVVFU1RfRU5EUE9JTlQiLCJTU09fQVVUSE9SSVpBVElPTl9SRVFVRVNUX0VORFBPSU5UIiwiSW52YWxpZFBhc3N3b3JkTWVzc2FnZSIsIkNoYW5nZVBhc3N3b3JkTWVzc2FnZSIsImRlYnVnIiwiZ2V0RGVidWciLCJUcm5UeXBlQ29kZSIsImlzQXV0aE1vZHVsZSIsInJlc3VsdCIsIkJvb2xlYW4iLCJhdXRoIiwiY2FsQ29ubmVjdFRva2VuIiwiU3RyaW5nIiwidHJpbSIsImF1dGhNb2R1bGVPclVuZGVmaW5lZCIsInVuZGVmaW5lZCIsImlzUGVuZGluZyIsInRyYW5zYWN0aW9uIiwiZGViQ3JkRGF0ZSIsImlzQ2FyZFRyYW5zYWN0aW9uRGV0YWlscyIsImlzQ2FyZFBlbmRpbmdUcmFuc2FjdGlvbkRldGFpbHMiLCJnZXRMb2dpbkZyYW1lIiwicGFnZSIsImZyYW1lIiwid2FpdFVudGlsIiwiZnJhbWVzIiwiZmluZCIsImYiLCJ1cmwiLCJpbmNsdWRlcyIsIlByb21pc2UiLCJyZXNvbHZlIiwiRXJyb3IiLCJoYXNJbnZhbGlkUGFzc3dvcmRFcnJvciIsImVycm9yRm91bmQiLCJlbGVtZW50UHJlc2VudE9uUGFnZSIsImVycm9yTWVzc2FnZSIsInBhZ2VFdmFsIiwiaXRlbSIsImlubmVyVGV4dCIsImhhc0NoYW5nZVBhc3N3b3JkRm9ybSIsImVyclRleHQiLCJnZXRQb3NzaWJsZUxvZ2luUmVzdWx0cyIsInVybHMiLCJMb2dpblJlc3VsdHMiLCJTdWNjZXNzIiwiSW52YWxpZFBhc3N3b3JkIiwib3B0aW9ucyIsIkNoYW5nZVBhc3N3b3JkIiwiY3JlYXRlTG9naW5GaWVsZHMiLCJjcmVkZW50aWFscyIsInNlbGVjdG9yIiwidmFsdWUiLCJ1c2VybmFtZSIsInBhc3N3b3JkIiwiY29udmVydFBhcnNlZERhdGFUb1RyYW5zYWN0aW9ucyIsImRhdGEiLCJwZW5kaW5nRGF0YSIsInBlbmRpbmdUcmFuc2FjdGlvbnMiLCJjYXJkc0xpc3QiLCJmbGF0TWFwIiwiY2FyZCIsImF1dGhEZXRhbGlzTGlzdCIsImJhbmtBY2NvdW50cyIsIm1vbnRoRGF0YSIsInJlZ3VsYXJEZWJpdERheXMiLCJhY2NvdW50cyIsImRlYml0RGF0ZXMiLCJpbW1lZGlhdGVEZWJpdERheXMiLCJpbW1pZGlhdGVEZWJpdHMiLCJkZWJpdERheXMiLCJjb21wbGV0ZWRUcmFuc2FjdGlvbnMiLCJkZWJpdERhdGUiLCJ0cmFuc2FjdGlvbnMiLCJhbGwiLCJtYXAiLCJudW1PZlBheW1lbnRzIiwibnVtYmVyT2ZQYXltZW50cyIsImluc3RhbGxtZW50cyIsIm51bWJlciIsImN1clBheW1lbnROdW0iLCJ0b3RhbCIsImRhdGUiLCJtb21lbnQiLCJ0cm5QdXJjaGFzZURhdGUiLCJjaGFyZ2VkQW1vdW50IiwidHJuQW10IiwiYW10QmVmb3JlQ29udkFuZEluZGV4Iiwib3JpZ2luYWxBbW91bnQiLCJ0cm5UeXBlQ29kZSIsImNyZWRpdCIsImlkZW50aWZpZXIiLCJ0cm5JbnRJZCIsInR5cGUiLCJyZWd1bGFyIiwic3RhbmRpbmdPcmRlciIsIlRyYW5zYWN0aW9uVHlwZXMiLCJOb3JtYWwiLCJJbnN0YWxsbWVudHMiLCJzdGF0dXMiLCJUcmFuc2FjdGlvblN0YXR1c2VzIiwiUGVuZGluZyIsIkNvbXBsZXRlZCIsImFkZCIsInRvSVNPU3RyaW5nIiwicHJvY2Vzc2VkRGF0ZSIsIkRhdGUiLCJvcmlnaW5hbEN1cnJlbmN5IiwidHJuQ3VycmVuY3lTeW1ib2wiLCJjaGFyZ2VkQ3VycmVuY3kiLCJkZWJDcmRDdXJyZW5jeVN5bWJvbCIsImRlc2NyaXB0aW9uIiwibWVyY2hhbnROYW1lIiwibWVtbyIsInRyYW5zVHlwZUNvbW1lbnREZXRhaWxzIiwidG9TdHJpbmciLCJjYXRlZ29yeSIsImJyYW5jaENvZGVEZXNjIiwiaW5jbHVkZVJhd1RyYW5zYWN0aW9uIiwicmF3VHJhbnNhY3Rpb24iLCJnZXRSYXdUcmFuc2FjdGlvbiIsIlZpc2FDYWxTY3JhcGVyIiwiQmFzZVNjcmFwZXJXaXRoQnJvd3NlciIsImF1dGhvcml6YXRpb24iLCJvcGVuTG9naW5Qb3B1cCIsIndhaXRVbnRpbEVsZW1lbnRGb3VuZCIsImNsaWNrQnV0dG9uIiwiZ2V0Q2FyZHMiLCJpbml0RGF0YSIsImdldEZyb21TZXNzaW9uU3RvcmFnZSIsImNhcmRzIiwiY2FyZFVuaXF1ZUlkIiwibGFzdDREaWdpdHMiLCJnZXRBdXRob3JpemF0aW9uSGVhZGVyIiwiYXV0aE1vZHVsZSIsImdldFhTaXRlSWQiLCJnZXRMb2dpbk9wdGlvbnMiLCJhdXRoUmVxdWVzdFByb21pc2UiLCJ3YWl0Rm9yUmVxdWVzdCIsInRpbWVvdXQiLCJjYXRjaCIsImxvZ2luVXJsIiwiZmllbGRzIiwic3VibWl0QnV0dG9uU2VsZWN0b3IiLCJwb3NzaWJsZVJlc3VsdHMiLCJjaGVja1JlYWRpbmVzcyIsInByZUFjdGlvbiIsInBvc3RBY3Rpb24iLCJ3YWl0Rm9yTmF2aWdhdGlvbiIsImN1cnJlbnRVcmwiLCJnZXRDdXJyZW50VXJsIiwiZW5kc1dpdGgiLCJyZXF1ZXN0IiwiaGVhZGVycyIsInJlcXVpcmVzQ2hhbmdlUGFzc3dvcmQiLCJ1c2VyQWdlbnQiLCJmZXRjaERhdGEiLCJkZWZhdWx0U3RhcnRNb21lbnQiLCJzdWJ0cmFjdCIsInN0YXJ0RGF0ZSIsInRvRGF0ZSIsInN0YXJ0TW9tZW50IiwibWF4IiwiZm9ybWF0IiwieFNpdGVJZCIsIkF1dGhvcml6YXRpb24iLCJmdXR1cmVNb250aHNUb1NjcmFwZSIsImZldGNoUG9zdCIsImNhcmRzRm9yRnJhbWVEYXRhIiwiZmluYWxNb250aFRvRmV0Y2hNb21lbnQiLCJtb250aHMiLCJkaWZmIiwiYWxsTW9udGhzRGF0YSIsImJhbmtJc3N1ZWRDYXJkcyIsImNhcmRMZXZlbEZyYW1lcyIsImNhcmRVbmlxdWVJREFycmF5IiwiaSIsIm1vbnRoIiwiY2xvbmUiLCJ5ZWFyIiwic3RhdHVzQ29kZSIsInRpdGxlIiwicHVzaCIsInR4bnMiLCJvdXRwdXREYXRhIiwiZW5hYmxlVHJhbnNhY3Rpb25zRmlsdGVyQnlEYXRlIiwiZmlsdGVyT2xkVHJhbnNhY3Rpb25zIiwiY29tYmluZUluc3RhbGxtZW50cyIsImJhbGFuY2UiLCJuZXh0VG90YWxEZWJpdCIsImFjY291bnROdW1iZXIiLCJKU09OIiwic3RyaW5naWZ5Iiwic3VjY2VzcyIsIl9kZWZhdWx0IiwiZXhwb3J0cyJdLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9zY3JhcGVycy92aXNhLWNhbC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgbW9tZW50IGZyb20gJ21vbWVudCc7XG5pbXBvcnQgeyB0eXBlIEhUVFBSZXF1ZXN0LCB0eXBlIEZyYW1lLCB0eXBlIFBhZ2UgfSBmcm9tICdwdXBwZXRlZXInO1xuaW1wb3J0IHsgZ2V0RGVidWcgfSBmcm9tICcuLi9oZWxwZXJzL2RlYnVnJztcbmltcG9ydCB7IGNsaWNrQnV0dG9uLCBlbGVtZW50UHJlc2VudE9uUGFnZSwgcGFnZUV2YWwsIHdhaXRVbnRpbEVsZW1lbnRGb3VuZCB9IGZyb20gJy4uL2hlbHBlcnMvZWxlbWVudHMtaW50ZXJhY3Rpb25zJztcbmltcG9ydCB7IGZldGNoUG9zdCB9IGZyb20gJy4uL2hlbHBlcnMvZmV0Y2gnO1xuaW1wb3J0IHsgZ2V0Q3VycmVudFVybCwgd2FpdEZvck5hdmlnYXRpb24gfSBmcm9tICcuLi9oZWxwZXJzL25hdmlnYXRpb24nO1xuaW1wb3J0IHsgZ2V0RnJvbVNlc3Npb25TdG9yYWdlIH0gZnJvbSAnLi4vaGVscGVycy9zdG9yYWdlJztcbmltcG9ydCB7IGZpbHRlck9sZFRyYW5zYWN0aW9ucywgZ2V0UmF3VHJhbnNhY3Rpb24gfSBmcm9tICcuLi9oZWxwZXJzL3RyYW5zYWN0aW9ucyc7XG5pbXBvcnQgeyB3YWl0VW50aWwgfSBmcm9tICcuLi9oZWxwZXJzL3dhaXRpbmcnO1xuaW1wb3J0IHsgVHJhbnNhY3Rpb25TdGF0dXNlcywgVHJhbnNhY3Rpb25UeXBlcywgdHlwZSBUcmFuc2FjdGlvbiwgdHlwZSBUcmFuc2FjdGlvbnNBY2NvdW50IH0gZnJvbSAnLi4vdHJhbnNhY3Rpb25zJztcbmltcG9ydCB7IEJhc2VTY3JhcGVyV2l0aEJyb3dzZXIsIExvZ2luUmVzdWx0cywgdHlwZSBMb2dpbk9wdGlvbnMgfSBmcm9tICcuL2Jhc2Utc2NyYXBlci13aXRoLWJyb3dzZXInO1xuaW1wb3J0IHsgdHlwZSBTY3JhcGVyU2NyYXBpbmdSZXN1bHQsIHR5cGUgU2NyYXBlck9wdGlvbnMgfSBmcm9tICcuL2ludGVyZmFjZSc7XG5cbmNvbnN0IGFwaUhlYWRlcnMgPSB7XG4gICdVc2VyLUFnZW50JzpcbiAgICAnTW96aWxsYS81LjAgKE1hY2ludG9zaDsgSW50ZWwgTWFjIE9TIFggMTBfMTVfNykgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzE0Mi4wLjAuMCBTYWZhcmkvNTM3LjM2JyxcbiAgT3JpZ2luOiAnaHR0cHM6Ly9kaWdpdGFsLXdlYi5jYWwtb25saW5lLmNvLmlsJyxcbiAgUmVmZXJlcjogJ2h0dHBzOi8vZGlnaXRhbC13ZWIuY2FsLW9ubGluZS5jby5pbCcsXG4gICdBY2NlcHQtTGFuZ3VhZ2UnOiAnaGUtSUwsaGU7cT0wLjksZW4tVVM7cT0wLjgsZW47cT0wLjcnLFxuICAnU2VjLUZldGNoLVNpdGUnOiAnc2FtZS1zaXRlJyxcbiAgJ1NlYy1GZXRjaC1Nb2RlJzogJ2NvcnMnLFxuICAnU2VjLUZldGNoLURlc3QnOiAnZW1wdHknLFxufTtcbmNvbnN0IExPR0lOX1VSTCA9ICdodHRwczovL3d3dy5jYWwtb25saW5lLmNvLmlsLyc7XG5jb25zdCBUUkFOU0FDVElPTlNfUkVRVUVTVF9FTkRQT0lOVCA9XG4gICdodHRwczovL2FwaS5jYWwtb25saW5lLmNvLmlsL1RyYW5zYWN0aW9ucy9hcGkvdHJhbnNhY3Rpb25zRGV0YWlscy9nZXRDYXJkVHJhbnNhY3Rpb25zRGV0YWlscyc7XG5jb25zdCBGUkFNRVNfUkVRVUVTVF9FTkRQT0lOVCA9ICdodHRwczovL2FwaS5jYWwtb25saW5lLmNvLmlsL0ZyYW1lcy9hcGkvRnJhbWVzL0dldEZyYW1lU3RhdHVzJztcbmNvbnN0IFBFTkRJTkdfVFJBTlNBQ1RJT05TX1JFUVVFU1RfRU5EUE9JTlQgPVxuICAnaHR0cHM6Ly9hcGkuY2FsLW9ubGluZS5jby5pbC9UcmFuc2FjdGlvbnMvYXBpL2FwcHJvdmFscy9nZXRDbGVhcmFuY2VSZXF1ZXN0cyc7XG5jb25zdCBTU09fQVVUSE9SSVpBVElPTl9SRVFVRVNUX0VORFBPSU5UID0gJ2h0dHBzOi8vY29ubmVjdC5jYWwtb25saW5lLmNvLmlsL2NvbC1yZXN0L2NhbGNvbm5lY3QvYXV0aGVudGljYXRpb24vU1NPJztcblxuY29uc3QgSW52YWxpZFBhc3N3b3JkTWVzc2FnZSA9ICfXqdedINeU157Xqdeq157XqSDXkNeVINeU16HXmdeh157XlCDXqdeU15XXlteg15Ug16nXkteV15nXmdedJztcbmNvbnN0IENoYW5nZVBhc3N3b3JkTWVzc2FnZSA9ICfXnNeU15fXnNeZ16Mg16HXmdeh157XlCc7XG5cbmNvbnN0IGRlYnVnID0gZ2V0RGVidWcoJ3Zpc2EtY2FsJyk7XG5cbmVudW0gVHJuVHlwZUNvZGUge1xuICByZWd1bGFyID0gJzUnLFxuICBjcmVkaXQgPSAnNicsXG4gIGluc3RhbGxtZW50cyA9ICc4JyxcbiAgc3RhbmRpbmdPcmRlciA9ICc5Jyxcbn1cblxuaW50ZXJmYWNlIFNjcmFwZWRUcmFuc2FjdGlvbiB7XG4gIGFtdEJlZm9yZUNvbnZBbmRJbmRleDogbnVtYmVyO1xuICBicmFuY2hDb2RlRGVzYzogc3RyaW5nO1xuICBjYXNoQWNjTWFuYWdlck5hbWU6IG51bGw7XG4gIGNhc2hBY2NvdW50TWFuYWdlcjogbnVsbDtcbiAgY2FzaEFjY291bnRUcm5BbXQ6IG51bWJlcjtcbiAgY2hhcmdlRXh0ZXJuYWxUb0NhcmRDb21tZW50OiBzdHJpbmc7XG4gIGNvbW1lbnRzOiBbXTtcbiAgY3VyUGF5bWVudE51bTogbnVtYmVyO1xuICBkZWJDcmRDdXJyZW5jeVN5bWJvbDogQ3VycmVuY3lTeW1ib2w7XG4gIGRlYkNyZERhdGU6IHN0cmluZztcbiAgZGViaXRTcHJlYWRJbmQ6IGJvb2xlYW47XG4gIGRpc2NvdW50QW1vdW50OiB1bmtub3duO1xuICBkaXNjb3VudFJlYXNvbjogdW5rbm93bjtcbiAgaW1tZWRpYXRlQ29tbWVudHM6IFtdO1xuICBpc0ltbWVkaWF0ZUNvbW1lbnRJbmQ6IGJvb2xlYW47XG4gIGlzSW1tZWRpYXRlSEhLSW5kOiBib29sZWFuO1xuICBpc01hcmdhcml0YTogYm9vbGVhbjtcbiAgaXNTcHJlYWRQYXltZW5zdEFicm9hZDogYm9vbGVhbjtcbiAgbGlua2VkQ29tbWVudHM6IFtdO1xuICBtZXJjaGFudEFkZHJlc3M6IHN0cmluZztcbiAgbWVyY2hhbnROYW1lOiBzdHJpbmc7XG4gIG1lcmNoYW50UGhvbmVObzogc3RyaW5nO1xuICBudW1PZlBheW1lbnRzOiBudW1iZXI7XG4gIG9uR29pbmdUcmFuc2FjdGlvbnNDb21tZW50OiBzdHJpbmc7XG4gIHJlZnVuZEluZDogYm9vbGVhbjtcbiAgcm91bmRpbmdBbW91bnQ6IHVua25vd247XG4gIHJvdW5kaW5nUmVhc29uOiB1bmtub3duO1xuICB0b2tlbkluZDogMDtcbiAgdG9rZW5OdW1iZXJQYXJ0NDogJyc7XG4gIHRyYW5zQ2FyZFByZXNlbnRJbmQ6IGJvb2xlYW47XG4gIHRyYW5zVHlwZUNvbW1lbnREZXRhaWxzOiBbXTtcbiAgdHJuQW10OiBudW1iZXI7XG4gIHRybkN1cnJlbmN5U3ltYm9sOiBDdXJyZW5jeVN5bWJvbDtcbiAgdHJuRXhhY1dheTogbnVtYmVyO1xuICB0cm5JbnRJZDogc3RyaW5nO1xuICB0cm5OdW1hcmV0b3I6IG51bWJlcjtcbiAgdHJuUHVyY2hhc2VEYXRlOiBzdHJpbmc7XG4gIHRyblR5cGU6IHN0cmluZztcbiAgdHJuVHlwZUNvZGU6IFRyblR5cGVDb2RlO1xuICB3YWxsZXRQcm92aWRlckNvZGU6IDA7XG4gIHdhbGxldFByb3ZpZGVyRGVzYzogJyc7XG4gIGVhcmx5UGF5bWVudEluZDogYm9vbGVhbjtcbn1cbmludGVyZmFjZSBTY3JhcGVkUGVuZGluZ1RyYW5zYWN0aW9uIHtcbiAgbWVyY2hhbnRJRDogc3RyaW5nO1xuICBtZXJjaGFudE5hbWU6IHN0cmluZztcbiAgdHJuUHVyY2hhc2VEYXRlOiBzdHJpbmc7XG4gIHdhbGxldFRyYW5JbmQ6IG51bWJlcjtcbiAgdHJhbnNhY3Rpb25zT3JpZ2luOiBudW1iZXI7XG4gIHRybkFtdDogbnVtYmVyO1xuICB0cGFBcHByb3ZhbEFtb3VudDogdW5rbm93bjtcbiAgdHJuQ3VycmVuY3lTeW1ib2w6IEN1cnJlbmN5U3ltYm9sO1xuICB0cm5UeXBlQ29kZTogVHJuVHlwZUNvZGU7XG4gIHRyblR5cGU6IHN0cmluZztcbiAgYnJhbmNoQ29kZURlc2M6IHN0cmluZztcbiAgdHJhbnNDYXJkUHJlc2VudEluZDogYm9vbGVhbjtcbiAgajVJbmRpY2F0b3I6IHN0cmluZztcbiAgbnVtYmVyT2ZQYXltZW50czogbnVtYmVyO1xuICBmaXJzdFBheW1lbnRBbW91bnQ6IG51bWJlcjtcbiAgdHJhbnNUeXBlQ29tbWVudERldGFpbHM6IFtdO1xufVxuaW50ZXJmYWNlIEluaXRSZXNwb25zZSB7XG4gIHJlc3VsdDoge1xuICAgIGNhcmRzOiB7XG4gICAgICBjYXJkVW5pcXVlSWQ6IHN0cmluZztcbiAgICAgIGxhc3Q0RGlnaXRzOiBzdHJpbmc7XG4gICAgICBba2V5OiBzdHJpbmddOiB1bmtub3duO1xuICAgIH1bXTtcbiAgfTtcbn1cbnR5cGUgQ3VycmVuY3lTeW1ib2wgPSBzdHJpbmc7XG5pbnRlcmZhY2UgQ2FyZFRyYW5zYWN0aW9uRGV0YWlsc0Vycm9yIHtcbiAgdGl0bGU6IHN0cmluZztcbiAgc3RhdHVzQ29kZTogbnVtYmVyO1xufVxuaW50ZXJmYWNlIENhcmRUcmFuc2FjdGlvbkRldGFpbHMgZXh0ZW5kcyBDYXJkVHJhbnNhY3Rpb25EZXRhaWxzRXJyb3Ige1xuICByZXN1bHQ6IHtcbiAgICBiYW5rQWNjb3VudHM6IHtcbiAgICAgIGJhbmtBY2NvdW50TnVtOiBzdHJpbmc7XG4gICAgICBiYW5rTmFtZTogc3RyaW5nO1xuICAgICAgY2hvaWNlRXh0ZXJuYWxUcmFuc2FjdGlvbnM6IGFueTtcbiAgICAgIGN1cnJlbnRCYW5rQWNjb3VudEluZDogYm9vbGVhbjtcbiAgICAgIGRlYml0RGF0ZXM6IHtcbiAgICAgICAgYmFza2V0QW1vdW50Q29tbWVudDogdW5rbm93bjtcbiAgICAgICAgY2hvaWNlSEhLRGViaXQ6IG51bWJlcjtcbiAgICAgICAgZGF0ZTogc3RyaW5nO1xuICAgICAgICBkZWJpdFJlYXNvbjogdW5rbm93bjtcbiAgICAgICAgZml4RGViaXRBbW91bnQ6IG51bWJlcjtcbiAgICAgICAgZnJvbVB1cmNoYXNlRGF0ZTogc3RyaW5nO1xuICAgICAgICBpc0Nob2ljZVJlcGFpbWVudDogYm9vbGVhbjtcbiAgICAgICAgdG9QdXJjaGFzZURhdGU6IHN0cmluZztcbiAgICAgICAgdG90YWxCYXNrZXRBbW91bnQ6IG51bWJlcjtcbiAgICAgICAgdG90YWxEZWJpdHM6IHtcbiAgICAgICAgICBjdXJyZW5jeVN5bWJvbDogQ3VycmVuY3lTeW1ib2w7XG4gICAgICAgICAgYW1vdW50OiBudW1iZXI7XG4gICAgICAgIH1bXTtcbiAgICAgICAgdHJhbnNhY3Rpb25zOiBTY3JhcGVkVHJhbnNhY3Rpb25bXTtcbiAgICAgIH1bXTtcbiAgICAgIGltbWlkaWF0ZURlYml0czogeyB0b3RhbERlYml0czogW107IGRlYml0RGF5czogW10gfTtcbiAgICB9W107XG4gICAgYmxvY2tlZENhcmRJbmQ6IGJvb2xlYW47XG4gIH07XG4gIHN0YXR1c0NvZGU6IDE7XG4gIHN0YXR1c0Rlc2NyaXB0aW9uOiBzdHJpbmc7XG4gIHN0YXR1c1RpdGxlOiBzdHJpbmc7XG59XG5pbnRlcmZhY2UgQ2FyZFBlbmRpbmdUcmFuc2FjdGlvbkRldGFpbHMgZXh0ZW5kcyBDYXJkVHJhbnNhY3Rpb25EZXRhaWxzRXJyb3Ige1xuICByZXN1bHQ6IHtcbiAgICBjYXJkc0xpc3Q6IHtcbiAgICAgIGNhcmRVbmlxdWVJRDogc3RyaW5nO1xuICAgICAgYXV0aERldGFsaXNMaXN0OiBTY3JhcGVkUGVuZGluZ1RyYW5zYWN0aW9uW107XG4gICAgfVtdO1xuICB9O1xuICBzdGF0dXNDb2RlOiAxO1xuICBzdGF0dXNEZXNjcmlwdGlvbjogc3RyaW5nO1xuICBzdGF0dXNUaXRsZTogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgQ2FyZExldmVsRnJhbWUge1xuICBjYXJkVW5pcXVlSWQ6IHN0cmluZztcbiAgbmV4dFRvdGFsRGViaXQ/OiBudW1iZXI7XG59XG5cbmludGVyZmFjZSBGcmFtZXNSZXNwb25zZSB7XG4gIHJlc3VsdD86IHtcbiAgICBiYW5rSXNzdWVkQ2FyZHM/OiB7XG4gICAgICBjYXJkTGV2ZWxGcmFtZXM/OiBDYXJkTGV2ZWxGcmFtZVtdO1xuICAgIH07XG4gIH07XG59XG5cbmludGVyZmFjZSBBdXRoTW9kdWxlIHtcbiAgYXV0aDoge1xuICAgIGNhbENvbm5lY3RUb2tlbjogc3RyaW5nIHwgbnVsbDtcbiAgfTtcbn1cblxuZnVuY3Rpb24gaXNBdXRoTW9kdWxlKHJlc3VsdDogYW55KTogcmVzdWx0IGlzIEF1dGhNb2R1bGUge1xuICByZXR1cm4gQm9vbGVhbihyZXN1bHQ/LmF1dGg/LmNhbENvbm5lY3RUb2tlbiAmJiBTdHJpbmcocmVzdWx0LmF1dGguY2FsQ29ubmVjdFRva2VuKS50cmltKCkpO1xufVxuXG5mdW5jdGlvbiBhdXRoTW9kdWxlT3JVbmRlZmluZWQocmVzdWx0OiBhbnkpOiBBdXRoTW9kdWxlIHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIGlzQXV0aE1vZHVsZShyZXN1bHQpID8gcmVzdWx0IDogdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBpc1BlbmRpbmcoXG4gIHRyYW5zYWN0aW9uOiBTY3JhcGVkVHJhbnNhY3Rpb24gfCBTY3JhcGVkUGVuZGluZ1RyYW5zYWN0aW9uLFxuKTogdHJhbnNhY3Rpb24gaXMgU2NyYXBlZFBlbmRpbmdUcmFuc2FjdGlvbiB7XG4gIHJldHVybiAodHJhbnNhY3Rpb24gYXMgU2NyYXBlZFRyYW5zYWN0aW9uKS5kZWJDcmREYXRlID09PSB1bmRlZmluZWQ7IC8vIGFuIGFyYml0cmFyeSBmaWVsZCB0aGF0IG9ubHkgYXBwZWFycyBpbiBhIGNvbXBsZXRlZCB0cmFuc2FjdGlvblxufVxuXG5mdW5jdGlvbiBpc0NhcmRUcmFuc2FjdGlvbkRldGFpbHMoXG4gIHJlc3VsdDogQ2FyZFRyYW5zYWN0aW9uRGV0YWlscyB8IENhcmRUcmFuc2FjdGlvbkRldGFpbHNFcnJvcixcbik6IHJlc3VsdCBpcyBDYXJkVHJhbnNhY3Rpb25EZXRhaWxzIHtcbiAgcmV0dXJuIChyZXN1bHQgYXMgQ2FyZFRyYW5zYWN0aW9uRGV0YWlscykucmVzdWx0ICE9PSB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIGlzQ2FyZFBlbmRpbmdUcmFuc2FjdGlvbkRldGFpbHMoXG4gIHJlc3VsdDogQ2FyZFBlbmRpbmdUcmFuc2FjdGlvbkRldGFpbHMgfCBDYXJkVHJhbnNhY3Rpb25EZXRhaWxzRXJyb3IsXG4pOiByZXN1bHQgaXMgQ2FyZFBlbmRpbmdUcmFuc2FjdGlvbkRldGFpbHMge1xuICByZXR1cm4gKHJlc3VsdCBhcyBDYXJkUGVuZGluZ1RyYW5zYWN0aW9uRGV0YWlscykucmVzdWx0ICE9PSB1bmRlZmluZWQ7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldExvZ2luRnJhbWUocGFnZTogUGFnZSkge1xuICBsZXQgZnJhbWU6IEZyYW1lIHwgbnVsbCA9IG51bGw7XG4gIGRlYnVnKCd3YWl0IHVudGlsIGxvZ2luIGZyYW1lIGZvdW5kJyk7XG4gIGF3YWl0IHdhaXRVbnRpbChcbiAgICAoKSA9PiB7XG4gICAgICBmcmFtZSA9IHBhZ2UuZnJhbWVzKCkuZmluZChmID0+IGYudXJsKCkuaW5jbHVkZXMoJ2Nvbm5lY3QnKSkgfHwgbnVsbDtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoISFmcmFtZSk7XG4gICAgfSxcbiAgICAnd2FpdCBmb3IgaWZyYW1lIHdpdGggbG9naW4gZm9ybScsXG4gICAgMTAwMDAsXG4gICAgMTAwMCxcbiAgKTtcblxuICBpZiAoIWZyYW1lKSB7XG4gICAgZGVidWcoJ2ZhaWxlZCB0byBmaW5kIGxvZ2luIGZyYW1lIGZvciAxMCBzZWNvbmRzJyk7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdmYWlsZWQgdG8gZXh0cmFjdCBsb2dpbiBpZnJhbWUnKTtcbiAgfVxuXG4gIHJldHVybiBmcmFtZTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gaGFzSW52YWxpZFBhc3N3b3JkRXJyb3IocGFnZTogUGFnZSkge1xuICBjb25zdCBmcmFtZSA9IGF3YWl0IGdldExvZ2luRnJhbWUocGFnZSk7XG4gIGNvbnN0IGVycm9yRm91bmQgPSBhd2FpdCBlbGVtZW50UHJlc2VudE9uUGFnZShmcmFtZSwgJ2Rpdi5nZW5lcmFsLWVycm9yID4gZGl2Jyk7XG4gIGNvbnN0IGVycm9yTWVzc2FnZSA9IGVycm9yRm91bmRcbiAgICA/IGF3YWl0IHBhZ2VFdmFsKGZyYW1lLCAnZGl2LmdlbmVyYWwtZXJyb3IgPiBkaXYnLCAnJywgaXRlbSA9PiB7XG4gICAgICAgIHJldHVybiAoaXRlbSBhcyBIVE1MRGl2RWxlbWVudCkuaW5uZXJUZXh0O1xuICAgICAgfSlcbiAgICA6ICcnO1xuICByZXR1cm4gZXJyb3JNZXNzYWdlID09PSBJbnZhbGlkUGFzc3dvcmRNZXNzYWdlO1xufVxuXG5hc3luYyBmdW5jdGlvbiBoYXNDaGFuZ2VQYXNzd29yZEZvcm0ocGFnZTogUGFnZSkge1xuICBjb25zdCBmcmFtZSA9IGF3YWl0IGdldExvZ2luRnJhbWUocGFnZSk7XG4gIC8vIFwi15vXk9eZINec15TXl9ec15nXoyDXodeZ16HXnteUINeZ16kg15zXnNeX15XXpSDXotecICfXqdeb15fXqteZINep150g157Xqdeq157XqSAvINeh15nXodee15QnINeR157XodeaINeU15vXoNeZ16HXlFwiXG4gIGNvbnN0IGVycm9yRm91bmQgPSBhd2FpdCBlbGVtZW50UHJlc2VudE9uUGFnZShmcmFtZSwgJy5lcnItZGVzYycpO1xuICBpZiAoZXJyb3JGb3VuZCkge1xuICAgIGNvbnN0IGVyclRleHQgPSBhd2FpdCBwYWdlRXZhbChmcmFtZSwgJy5lcnItZGVzYycsICcnLCBpdGVtID0+IHtcbiAgICAgIHJldHVybiAoaXRlbSBhcyBIVE1MRWxlbWVudCkuaW5uZXJUZXh0LnRyaW0oKTtcbiAgICB9KTtcbiAgICByZXR1cm4gZXJyVGV4dC5pbmNsdWRlcyhDaGFuZ2VQYXNzd29yZE1lc3NhZ2UpO1xuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cblxuZnVuY3Rpb24gZ2V0UG9zc2libGVMb2dpblJlc3VsdHMoKSB7XG4gIGRlYnVnKCdyZXR1cm4gcG9zc2libGUgbG9naW4gcmVzdWx0cycpO1xuICBjb25zdCB1cmxzOiBMb2dpbk9wdGlvbnNbJ3Bvc3NpYmxlUmVzdWx0cyddID0ge1xuICAgIFtMb2dpblJlc3VsdHMuU3VjY2Vzc106IFsvZGFzaGJvYXJkL2ldLFxuICAgIFtMb2dpblJlc3VsdHMuSW52YWxpZFBhc3N3b3JkXTogW1xuICAgICAgYXN5bmMgKG9wdGlvbnM/OiB7IHBhZ2U/OiBQYWdlIH0pID0+IHtcbiAgICAgICAgY29uc3QgcGFnZSA9IG9wdGlvbnM/LnBhZ2U7XG4gICAgICAgIGlmICghcGFnZSkge1xuICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gaGFzSW52YWxpZFBhc3N3b3JkRXJyb3IocGFnZSk7XG4gICAgICB9LFxuICAgIF0sXG4gICAgLy8gW0xvZ2luUmVzdWx0cy5BY2NvdW50QmxvY2tlZF06IFtdLCAvLyBUT0RPIGFkZCB3aGVuIHJlYWNoaW5nIHRoaXMgc2NlbmFyaW9cbiAgICBbTG9naW5SZXN1bHRzLkNoYW5nZVBhc3N3b3JkXTogW1xuICAgICAgYXN5bmMgKG9wdGlvbnM/OiB7IHBhZ2U/OiBQYWdlIH0pID0+IHtcbiAgICAgICAgY29uc3QgcGFnZSA9IG9wdGlvbnM/LnBhZ2U7XG4gICAgICAgIGlmICghcGFnZSkge1xuICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gaGFzQ2hhbmdlUGFzc3dvcmRGb3JtKHBhZ2UpO1xuICAgICAgfSxcbiAgICBdLFxuICB9O1xuICByZXR1cm4gdXJscztcbn1cblxuZnVuY3Rpb24gY3JlYXRlTG9naW5GaWVsZHMoY3JlZGVudGlhbHM6IFNjcmFwZXJTcGVjaWZpY0NyZWRlbnRpYWxzKSB7XG4gIGRlYnVnKCdjcmVhdGUgbG9naW4gZmllbGRzIGZvciB1c2VybmFtZSBhbmQgcGFzc3dvcmQnKTtcbiAgcmV0dXJuIFtcbiAgICB7IHNlbGVjdG9yOiAnW2Zvcm1jb250cm9sbmFtZT1cInVzZXJOYW1lXCJdJywgdmFsdWU6IGNyZWRlbnRpYWxzLnVzZXJuYW1lIH0sXG4gICAgeyBzZWxlY3RvcjogJ1tmb3JtY29udHJvbG5hbWU9XCJwYXNzd29yZFwiXScsIHZhbHVlOiBjcmVkZW50aWFscy5wYXNzd29yZCB9LFxuICBdO1xufVxuXG5mdW5jdGlvbiBjb252ZXJ0UGFyc2VkRGF0YVRvVHJhbnNhY3Rpb25zKFxuICBkYXRhOiBDYXJkVHJhbnNhY3Rpb25EZXRhaWxzW10sXG4gIHBlbmRpbmdEYXRhPzogQ2FyZFBlbmRpbmdUcmFuc2FjdGlvbkRldGFpbHMgfCBudWxsLFxuICBvcHRpb25zPzogU2NyYXBlck9wdGlvbnMsXG4pOiBUcmFuc2FjdGlvbltdIHtcbiAgY29uc3QgcGVuZGluZ1RyYW5zYWN0aW9ucyA9IHBlbmRpbmdEYXRhPy5yZXN1bHRcbiAgICA/IHBlbmRpbmdEYXRhLnJlc3VsdC5jYXJkc0xpc3QuZmxhdE1hcChjYXJkID0+IGNhcmQuYXV0aERldGFsaXNMaXN0KVxuICAgIDogW107XG5cbiAgY29uc3QgYmFua0FjY291bnRzID0gZGF0YS5mbGF0TWFwKG1vbnRoRGF0YSA9PiBtb250aERhdGEucmVzdWx0LmJhbmtBY2NvdW50cyk7XG4gIGNvbnN0IHJlZ3VsYXJEZWJpdERheXMgPSBiYW5rQWNjb3VudHMuZmxhdE1hcChhY2NvdW50cyA9PiBhY2NvdW50cy5kZWJpdERhdGVzKTtcbiAgY29uc3QgaW1tZWRpYXRlRGViaXREYXlzID0gYmFua0FjY291bnRzLmZsYXRNYXAoYWNjb3VudHMgPT4gYWNjb3VudHMuaW1taWRpYXRlRGViaXRzLmRlYml0RGF5cyk7XG4gIGNvbnN0IGNvbXBsZXRlZFRyYW5zYWN0aW9ucyA9IFsuLi5yZWd1bGFyRGViaXREYXlzLCAuLi5pbW1lZGlhdGVEZWJpdERheXNdLmZsYXRNYXAoXG4gICAgZGViaXREYXRlID0+IGRlYml0RGF0ZS50cmFuc2FjdGlvbnMsXG4gICk7XG5cbiAgY29uc3QgYWxsOiAoU2NyYXBlZFRyYW5zYWN0aW9uIHwgU2NyYXBlZFBlbmRpbmdUcmFuc2FjdGlvbilbXSA9IFsuLi5wZW5kaW5nVHJhbnNhY3Rpb25zLCAuLi5jb21wbGV0ZWRUcmFuc2FjdGlvbnNdO1xuXG4gIHJldHVybiBhbGwubWFwKHRyYW5zYWN0aW9uID0+IHtcbiAgICBjb25zdCBudW1PZlBheW1lbnRzID0gaXNQZW5kaW5nKHRyYW5zYWN0aW9uKSA/IHRyYW5zYWN0aW9uLm51bWJlck9mUGF5bWVudHMgOiB0cmFuc2FjdGlvbi5udW1PZlBheW1lbnRzO1xuICAgIGNvbnN0IGluc3RhbGxtZW50cyA9IG51bU9mUGF5bWVudHNcbiAgICAgID8ge1xuICAgICAgICAgIG51bWJlcjogaXNQZW5kaW5nKHRyYW5zYWN0aW9uKSA/IDEgOiB0cmFuc2FjdGlvbi5jdXJQYXltZW50TnVtLFxuICAgICAgICAgIHRvdGFsOiBudW1PZlBheW1lbnRzLFxuICAgICAgICB9XG4gICAgICA6IHVuZGVmaW5lZDtcblxuICAgIGNvbnN0IGRhdGUgPSBtb21lbnQodHJhbnNhY3Rpb24udHJuUHVyY2hhc2VEYXRlKTtcblxuICAgIGNvbnN0IGNoYXJnZWRBbW91bnQgPSAoaXNQZW5kaW5nKHRyYW5zYWN0aW9uKSA/IHRyYW5zYWN0aW9uLnRybkFtdCA6IHRyYW5zYWN0aW9uLmFtdEJlZm9yZUNvbnZBbmRJbmRleCkgKiAtMTtcbiAgICBjb25zdCBvcmlnaW5hbEFtb3VudCA9IHRyYW5zYWN0aW9uLnRybkFtdCAqICh0cmFuc2FjdGlvbi50cm5UeXBlQ29kZSA9PT0gVHJuVHlwZUNvZGUuY3JlZGl0ID8gMSA6IC0xKTtcblxuICAgIGNvbnN0IHJlc3VsdDogVHJhbnNhY3Rpb24gPSB7XG4gICAgICBpZGVudGlmaWVyOiAhaXNQZW5kaW5nKHRyYW5zYWN0aW9uKSA/IHRyYW5zYWN0aW9uLnRybkludElkIDogdW5kZWZpbmVkLFxuICAgICAgdHlwZTogW1RyblR5cGVDb2RlLnJlZ3VsYXIsIFRyblR5cGVDb2RlLnN0YW5kaW5nT3JkZXJdLmluY2x1ZGVzKHRyYW5zYWN0aW9uLnRyblR5cGVDb2RlKVxuICAgICAgICA/IFRyYW5zYWN0aW9uVHlwZXMuTm9ybWFsXG4gICAgICAgIDogVHJhbnNhY3Rpb25UeXBlcy5JbnN0YWxsbWVudHMsXG4gICAgICBzdGF0dXM6IGlzUGVuZGluZyh0cmFuc2FjdGlvbikgPyBUcmFuc2FjdGlvblN0YXR1c2VzLlBlbmRpbmcgOiBUcmFuc2FjdGlvblN0YXR1c2VzLkNvbXBsZXRlZCxcbiAgICAgIGRhdGU6IGluc3RhbGxtZW50cyA/IGRhdGUuYWRkKGluc3RhbGxtZW50cy5udW1iZXIgLSAxLCAnbW9udGgnKS50b0lTT1N0cmluZygpIDogZGF0ZS50b0lTT1N0cmluZygpLFxuICAgICAgcHJvY2Vzc2VkRGF0ZTogaXNQZW5kaW5nKHRyYW5zYWN0aW9uKSA/IGRhdGUudG9JU09TdHJpbmcoKSA6IG5ldyBEYXRlKHRyYW5zYWN0aW9uLmRlYkNyZERhdGUpLnRvSVNPU3RyaW5nKCksXG4gICAgICBvcmlnaW5hbEFtb3VudCxcbiAgICAgIG9yaWdpbmFsQ3VycmVuY3k6IHRyYW5zYWN0aW9uLnRybkN1cnJlbmN5U3ltYm9sLFxuICAgICAgY2hhcmdlZEFtb3VudCxcbiAgICAgIGNoYXJnZWRDdXJyZW5jeTogIWlzUGVuZGluZyh0cmFuc2FjdGlvbikgPyB0cmFuc2FjdGlvbi5kZWJDcmRDdXJyZW5jeVN5bWJvbCA6IHVuZGVmaW5lZCxcbiAgICAgIGRlc2NyaXB0aW9uOiB0cmFuc2FjdGlvbi5tZXJjaGFudE5hbWUsXG4gICAgICBtZW1vOiB0cmFuc2FjdGlvbi50cmFuc1R5cGVDb21tZW50RGV0YWlscy50b1N0cmluZygpLFxuICAgICAgY2F0ZWdvcnk6IHRyYW5zYWN0aW9uLmJyYW5jaENvZGVEZXNjLFxuICAgIH07XG5cbiAgICBpZiAoaW5zdGFsbG1lbnRzKSB7XG4gICAgICByZXN1bHQuaW5zdGFsbG1lbnRzID0gaW5zdGFsbG1lbnRzO1xuICAgIH1cblxuICAgIGlmIChvcHRpb25zPy5pbmNsdWRlUmF3VHJhbnNhY3Rpb24pIHtcbiAgICAgIHJlc3VsdC5yYXdUcmFuc2FjdGlvbiA9IGdldFJhd1RyYW5zYWN0aW9uKHRyYW5zYWN0aW9uKTtcbiAgICB9XG5cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9KTtcbn1cblxudHlwZSBTY3JhcGVyU3BlY2lmaWNDcmVkZW50aWFscyA9IHsgdXNlcm5hbWU6IHN0cmluZzsgcGFzc3dvcmQ6IHN0cmluZyB9O1xuXG5jbGFzcyBWaXNhQ2FsU2NyYXBlciBleHRlbmRzIEJhc2VTY3JhcGVyV2l0aEJyb3dzZXI8U2NyYXBlclNwZWNpZmljQ3JlZGVudGlhbHM+IHtcbiAgcHJpdmF0ZSBhdXRob3JpemF0aW9uOiBzdHJpbmcgfCB1bmRlZmluZWQgPSB1bmRlZmluZWQ7XG5cbiAgcHJpdmF0ZSBhdXRoUmVxdWVzdFByb21pc2U6IFByb21pc2U8SFRUUFJlcXVlc3QgfCB1bmRlZmluZWQ+IHwgdW5kZWZpbmVkO1xuXG4gIG9wZW5Mb2dpblBvcHVwID0gYXN5bmMgKCkgPT4ge1xuICAgIGRlYnVnKCdvcGVuIGxvZ2luIHBvcHVwLCB3YWl0IHVudGlsIGxvZ2luIGJ1dHRvbiBhdmFpbGFibGUnKTtcbiAgICBhd2FpdCB3YWl0VW50aWxFbGVtZW50Rm91bmQodGhpcy5wYWdlLCAnI2NjTG9naW5EZXNrdG9wQnRuJywgdHJ1ZSk7XG4gICAgZGVidWcoJ2NsaWNrIG9uIHRoZSBsb2dpbiBidXR0b24nKTtcbiAgICBhd2FpdCBjbGlja0J1dHRvbih0aGlzLnBhZ2UsICcjY2NMb2dpbkRlc2t0b3BCdG4nKTtcbiAgICBkZWJ1ZygnZ2V0IHRoZSBmcmFtZSB0aGF0IGhvbGRzIHRoZSBsb2dpbicpO1xuICAgIGNvbnN0IGZyYW1lID0gYXdhaXQgZ2V0TG9naW5GcmFtZSh0aGlzLnBhZ2UpO1xuICAgIGRlYnVnKCd3YWl0IHVudGlsIHRoZSBwYXNzd29yZCBsb2dpbiB0YWIgaGVhZGVyIGlzIGF2YWlsYWJsZScpO1xuICAgIGF3YWl0IHdhaXRVbnRpbEVsZW1lbnRGb3VuZChmcmFtZSwgJyNyZWd1bGFyLWxvZ2luJyk7XG4gICAgZGVidWcoJ25hdmlnYXRlIHRvIHRoZSBwYXNzd29yZCBsb2dpbiB0YWInKTtcbiAgICBhd2FpdCBjbGlja0J1dHRvbihmcmFtZSwgJyNyZWd1bGFyLWxvZ2luJyk7XG4gICAgZGVidWcoJ3dhaXQgdW50aWwgdGhlIHBhc3N3b3JkIGxvZ2luIHRhYiBpcyBhY3RpdmUnKTtcbiAgICBhd2FpdCB3YWl0VW50aWxFbGVtZW50Rm91bmQoZnJhbWUsICdyZWd1bGFyLWxvZ2luJyk7XG5cbiAgICByZXR1cm4gZnJhbWU7XG4gIH07XG5cbiAgYXN5bmMgZ2V0Q2FyZHMoKSB7XG4gICAgY29uc3QgaW5pdERhdGEgPSBhd2FpdCB3YWl0VW50aWwoXG4gICAgICAoKSA9PiBnZXRGcm9tU2Vzc2lvblN0b3JhZ2U8SW5pdFJlc3BvbnNlPih0aGlzLnBhZ2UsICdpbml0JyksXG4gICAgICAnZ2V0IGluaXQgZGF0YSBpbiBzZXNzaW9uIHN0b3JhZ2UnLFxuICAgICAgMTAwMDAsXG4gICAgICAxMDAwLFxuICAgICk7XG4gICAgaWYgKCFpbml0RGF0YSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdjb3VsZCBub3QgZmluZCBcImluaXRcIiBkYXRhIGluIHNlc3Npb24gc3RvcmFnZScpO1xuICAgIH1cbiAgICByZXR1cm4gaW5pdERhdGE/LnJlc3VsdC5jYXJkcy5tYXAoKHsgY2FyZFVuaXF1ZUlkLCBsYXN0NERpZ2l0cyB9KSA9PiAoeyBjYXJkVW5pcXVlSWQsIGxhc3Q0RGlnaXRzIH0pKTtcbiAgfVxuXG4gIGFzeW5jIGdldEF1dGhvcml6YXRpb25IZWFkZXIoKSB7XG4gICAgaWYgKCF0aGlzLmF1dGhvcml6YXRpb24pIHtcbiAgICAgIGRlYnVnKCdmZXRjaGluZyBhdXRob3JpemF0aW9uIGhlYWRlcicpO1xuICAgICAgY29uc3QgYXV0aE1vZHVsZSA9IGF3YWl0IHdhaXRVbnRpbChcbiAgICAgICAgYXN5bmMgKCkgPT4gYXV0aE1vZHVsZU9yVW5kZWZpbmVkKGF3YWl0IGdldEZyb21TZXNzaW9uU3RvcmFnZTxBdXRoTW9kdWxlPih0aGlzLnBhZ2UsICdhdXRoLW1vZHVsZScpKSxcbiAgICAgICAgJ2dldCBhdXRob3JpemF0aW9uIGhlYWRlciB3aXRoIHZhbGlkIHRva2VuIGluIHNlc3Npb24gc3RvcmFnZScsXG4gICAgICAgIDEwXzAwMCxcbiAgICAgICAgNTAsXG4gICAgICApO1xuICAgICAgcmV0dXJuIGBDQUxBdXRoU2NoZW1lICR7YXV0aE1vZHVsZS5hdXRoLmNhbENvbm5lY3RUb2tlbn1gO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5hdXRob3JpemF0aW9uO1xuICB9XG5cbiAgYXN5bmMgZ2V0WFNpdGVJZCgpIHtcbiAgICAvKlxuICAgICAgSSBkb24ndCBrbm93IGlmIHRoZSBjb25zdGFudCBiZWxvdyB3aWxsIGNoYW5nZSBpbiB0aGUgZmVhdHVyZS5cbiAgICAgIElmIHNvLCB1c2UgdGhlIG5leHQgY29kZTpcblxuICAgICAgcmV0dXJuIHRoaXMucGFnZS5ldmFsdWF0ZSgoKSA9PiBuZXcgVXQoKS54U2l0ZUlkKTtcblxuICAgICAgVG8gZ2V0IHRoZSBjbGFzc25hbWUgc2VhcmNoIGZvciAneFNpdGVJZCcgaW4gdGhlIHBhZ2Ugc291cmNlXG4gICAgICBjbGFzcyBVdCB7XG4gICAgICAgIGNvbnN0cnVjdG9yKF9lLCBvbiwgeW4pIHtcbiAgICAgICAgICAgIHRoaXMuc3RvcmUgPSBfZSxcbiAgICAgICAgICAgIHRoaXMuY29uZmlnID0gb24sXG4gICAgICAgICAgICB0aGlzLmV2ZW50QnVzU2VydmljZSA9IHluLFxuICAgICAgICAgICAgdGhpcy54U2l0ZUlkID0gXCIwOTAzMTk4Ny0yNzNFLTIzMTEtOTA2Qy04QUY4NUIxN0M4RDlcIixcbiAgICAqL1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoJzA5MDMxOTg3LTI3M0UtMjMxMS05MDZDLThBRjg1QjE3QzhEOScpO1xuICB9XG5cbiAgZ2V0TG9naW5PcHRpb25zKGNyZWRlbnRpYWxzOiBTY3JhcGVyU3BlY2lmaWNDcmVkZW50aWFscyk6IExvZ2luT3B0aW9ucyB7XG4gICAgdGhpcy5hdXRoUmVxdWVzdFByb21pc2UgPSB0aGlzLnBhZ2VcbiAgICAgIC53YWl0Rm9yUmVxdWVzdChTU09fQVVUSE9SSVpBVElPTl9SRVFVRVNUX0VORFBPSU5ULCB7IHRpbWVvdXQ6IDEwXzAwMCB9KVxuICAgICAgLmNhdGNoKGUgPT4ge1xuICAgICAgICBkZWJ1ZygnZXJyb3Igd2hpbGUgd2FpdGluZyBmb3IgdGhlIHRva2VuIHJlcXVlc3QnLCBlKTtcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgIH0pO1xuICAgIHJldHVybiB7XG4gICAgICBsb2dpblVybDogYCR7TE9HSU5fVVJMfWAsXG4gICAgICBmaWVsZHM6IGNyZWF0ZUxvZ2luRmllbGRzKGNyZWRlbnRpYWxzKSxcbiAgICAgIHN1Ym1pdEJ1dHRvblNlbGVjdG9yOiAnYnV0dG9uW3R5cGU9XCJzdWJtaXRcIl0nLFxuICAgICAgcG9zc2libGVSZXN1bHRzOiBnZXRQb3NzaWJsZUxvZ2luUmVzdWx0cygpLFxuICAgICAgY2hlY2tSZWFkaW5lc3M6IGFzeW5jICgpID0+IHdhaXRVbnRpbEVsZW1lbnRGb3VuZCh0aGlzLnBhZ2UsICcjY2NMb2dpbkRlc2t0b3BCdG4nKSxcbiAgICAgIHByZUFjdGlvbjogdGhpcy5vcGVuTG9naW5Qb3B1cCxcbiAgICAgIHBvc3RBY3Rpb246IGFzeW5jICgpID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBhd2FpdCB3YWl0Rm9yTmF2aWdhdGlvbih0aGlzLnBhZ2UpO1xuICAgICAgICAgIGNvbnN0IGN1cnJlbnRVcmwgPSBhd2FpdCBnZXRDdXJyZW50VXJsKHRoaXMucGFnZSk7XG4gICAgICAgICAgaWYgKGN1cnJlbnRVcmwuZW5kc1dpdGgoJ3NpdGUtdHV0b3JpYWwnKSkge1xuICAgICAgICAgICAgYXdhaXQgY2xpY2tCdXR0b24odGhpcy5wYWdlLCAnYnV0dG9uLmJ0bi1jbG9zZScpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjb25zdCByZXF1ZXN0ID0gYXdhaXQgdGhpcy5hdXRoUmVxdWVzdFByb21pc2U7XG4gICAgICAgICAgdGhpcy5hdXRob3JpemF0aW9uID0gU3RyaW5nKHJlcXVlc3Q/LmhlYWRlcnMoKS5hdXRob3JpemF0aW9uIHx8ICcnKS50cmltKCk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBjb25zdCBjdXJyZW50VXJsID0gYXdhaXQgZ2V0Q3VycmVudFVybCh0aGlzLnBhZ2UpO1xuICAgICAgICAgIGlmIChjdXJyZW50VXJsLmVuZHNXaXRoKCdkYXNoYm9hcmQnKSkgcmV0dXJuO1xuICAgICAgICAgIGNvbnN0IHJlcXVpcmVzQ2hhbmdlUGFzc3dvcmQgPSBhd2FpdCBoYXNDaGFuZ2VQYXNzd29yZEZvcm0odGhpcy5wYWdlKTtcbiAgICAgICAgICBpZiAocmVxdWlyZXNDaGFuZ2VQYXNzd29yZCkgcmV0dXJuO1xuICAgICAgICAgIHRocm93IGU7XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgICB1c2VyQWdlbnQ6IGFwaUhlYWRlcnNbJ1VzZXItQWdlbnQnXSxcbiAgICB9O1xuICB9XG5cbiAgYXN5bmMgZmV0Y2hEYXRhKCk6IFByb21pc2U8U2NyYXBlclNjcmFwaW5nUmVzdWx0PiB7XG4gICAgY29uc3QgZGVmYXVsdFN0YXJ0TW9tZW50ID0gbW9tZW50KCkuc3VidHJhY3QoMSwgJ3llYXJzJykuc3VidHJhY3QoNiwgJ21vbnRocycpLmFkZCgxLCAnZGF5Jyk7XG4gICAgY29uc3Qgc3RhcnREYXRlID0gdGhpcy5vcHRpb25zLnN0YXJ0RGF0ZSB8fCBkZWZhdWx0U3RhcnRNb21lbnQudG9EYXRlKCk7XG4gICAgY29uc3Qgc3RhcnRNb21lbnQgPSBtb21lbnQubWF4KGRlZmF1bHRTdGFydE1vbWVudCwgbW9tZW50KHN0YXJ0RGF0ZSkpO1xuICAgIGRlYnVnKGBmZXRjaCB0cmFuc2FjdGlvbnMgc3RhcnRpbmcgJHtzdGFydE1vbWVudC5mb3JtYXQoKX1gKTtcblxuICAgIGNvbnN0IFtjYXJkcywgeFNpdGVJZCwgQXV0aG9yaXphdGlvbl0gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgICB0aGlzLmdldENhcmRzKCksXG4gICAgICB0aGlzLmdldFhTaXRlSWQoKSxcbiAgICAgIHRoaXMuZ2V0QXV0aG9yaXphdGlvbkhlYWRlcigpLFxuICAgIF0pO1xuXG4gICAgY29uc3QgZnV0dXJlTW9udGhzVG9TY3JhcGUgPSB0aGlzLm9wdGlvbnMuZnV0dXJlTW9udGhzVG9TY3JhcGUgPz8gMTtcblxuICAgIGRlYnVnKCdmZXRjaCBmcmFtZXMgKG1pc2dhcm90KSBvZiBjYXJkcycpO1xuICAgIGNvbnN0IGZyYW1lcyA9IGF3YWl0IGZldGNoUG9zdDxGcmFtZXNSZXNwb25zZT4oXG4gICAgICBGUkFNRVNfUkVRVUVTVF9FTkRQT0lOVCxcbiAgICAgIHsgY2FyZHNGb3JGcmFtZURhdGE6IGNhcmRzLm1hcCgoeyBjYXJkVW5pcXVlSWQgfSkgPT4gKHsgY2FyZFVuaXF1ZUlkIH0pKSB9LFxuICAgICAge1xuICAgICAgICBBdXRob3JpemF0aW9uLFxuICAgICAgICAnWC1TaXRlLUlkJzogeFNpdGVJZCxcbiAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgLi4uYXBpSGVhZGVycyxcbiAgICAgIH0sXG4gICAgKTtcblxuICAgIGNvbnN0IGFjY291bnRzID0gYXdhaXQgUHJvbWlzZS5hbGwoXG4gICAgICBjYXJkcy5tYXAoYXN5bmMgY2FyZCA9PiB7XG4gICAgICAgIGNvbnN0IGZpbmFsTW9udGhUb0ZldGNoTW9tZW50ID0gbW9tZW50KCkuYWRkKGZ1dHVyZU1vbnRoc1RvU2NyYXBlLCAnbW9udGgnKTtcbiAgICAgICAgY29uc3QgbW9udGhzID0gZmluYWxNb250aFRvRmV0Y2hNb21lbnQuZGlmZihzdGFydE1vbWVudCwgJ21vbnRocycpO1xuICAgICAgICBjb25zdCBhbGxNb250aHNEYXRhOiBDYXJkVHJhbnNhY3Rpb25EZXRhaWxzW10gPSBbXTtcbiAgICAgICAgY29uc3QgZnJhbWUgPSBmcmFtZXMucmVzdWx0Py5iYW5rSXNzdWVkQ2FyZHM/LmNhcmRMZXZlbEZyYW1lcz8uZmluZChcbiAgICAgICAgICAoZjogQ2FyZExldmVsRnJhbWUpID0+IGYuY2FyZFVuaXF1ZUlkID09PSBjYXJkLmNhcmRVbmlxdWVJZCxcbiAgICAgICAgKTtcblxuICAgICAgICBkZWJ1ZyhgZmV0Y2ggcGVuZGluZyB0cmFuc2FjdGlvbnMgZm9yIGNhcmQgJHtjYXJkLmNhcmRVbmlxdWVJZH1gKTtcbiAgICAgICAgbGV0IHBlbmRpbmdEYXRhID0gYXdhaXQgZmV0Y2hQb3N0KFxuICAgICAgICAgIFBFTkRJTkdfVFJBTlNBQ1RJT05TX1JFUVVFU1RfRU5EUE9JTlQsXG4gICAgICAgICAgeyBjYXJkVW5pcXVlSURBcnJheTogW2NhcmQuY2FyZFVuaXF1ZUlkXSB9LFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIEF1dGhvcml6YXRpb24sXG4gICAgICAgICAgICAnWC1TaXRlLUlkJzogeFNpdGVJZCxcbiAgICAgICAgICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICAgICAgICAuLi5hcGlIZWFkZXJzLFxuICAgICAgICAgIH0sXG4gICAgICAgICk7XG5cbiAgICAgICAgZGVidWcoYGZldGNoIGNvbXBsZXRlZCB0cmFuc2FjdGlvbnMgZm9yIGNhcmQgJHtjYXJkLmNhcmRVbmlxdWVJZH1gKTtcbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPD0gbW9udGhzOyBpKyspIHtcbiAgICAgICAgICBjb25zdCBtb250aCA9IGZpbmFsTW9udGhUb0ZldGNoTW9tZW50LmNsb25lKCkuc3VidHJhY3QoaSwgJ21vbnRocycpO1xuICAgICAgICAgIGNvbnN0IG1vbnRoRGF0YSA9IGF3YWl0IGZldGNoUG9zdChcbiAgICAgICAgICAgIFRSQU5TQUNUSU9OU19SRVFVRVNUX0VORFBPSU5ULFxuICAgICAgICAgICAgeyBjYXJkVW5pcXVlSWQ6IGNhcmQuY2FyZFVuaXF1ZUlkLCBtb250aDogbW9udGguZm9ybWF0KCdNJyksIHllYXI6IG1vbnRoLmZvcm1hdCgnWVlZWScpIH0sXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIEF1dGhvcml6YXRpb24sXG4gICAgICAgICAgICAgICdYLVNpdGUtSWQnOiB4U2l0ZUlkLFxuICAgICAgICAgICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgICAgICAgICAuLi5hcGlIZWFkZXJzLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICApO1xuXG4gICAgICAgICAgaWYgKG1vbnRoRGF0YT8uc3RhdHVzQ29kZSAhPT0gMSlcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgYGZhaWxlZCB0byBmZXRjaCB0cmFuc2FjdGlvbnMgZm9yIGNhcmQgJHtjYXJkLmxhc3Q0RGlnaXRzfS4gTWVzc2FnZTogJHttb250aERhdGE/LnRpdGxlIHx8ICcnfWAsXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgaWYgKCFpc0NhcmRUcmFuc2FjdGlvbkRldGFpbHMobW9udGhEYXRhKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdtb250aERhdGEgaXMgbm90IG9mIHR5cGUgQ2FyZFRyYW5zYWN0aW9uRGV0YWlscycpO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGFsbE1vbnRoc0RhdGEucHVzaChtb250aERhdGEpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHBlbmRpbmdEYXRhPy5zdGF0dXNDb2RlICE9PSAxICYmIHBlbmRpbmdEYXRhPy5zdGF0dXNDb2RlICE9PSA5Nikge1xuICAgICAgICAgIGRlYnVnKFxuICAgICAgICAgICAgYGZhaWxlZCB0byBmZXRjaCBwZW5kaW5nIHRyYW5zYWN0aW9ucyBmb3IgY2FyZCAke2NhcmQubGFzdDREaWdpdHN9LiBNZXNzYWdlOiAke3BlbmRpbmdEYXRhPy50aXRsZSB8fCAnJ31gLFxuICAgICAgICAgICk7XG4gICAgICAgICAgcGVuZGluZ0RhdGEgPSBudWxsO1xuICAgICAgICB9IGVsc2UgaWYgKCFpc0NhcmRQZW5kaW5nVHJhbnNhY3Rpb25EZXRhaWxzKHBlbmRpbmdEYXRhKSkge1xuICAgICAgICAgIGRlYnVnKCdwZW5kaW5nRGF0YSBpcyBub3Qgb2YgdHlwZSBDYXJkVHJhbnNhY3Rpb25EZXRhaWxzJyk7XG4gICAgICAgICAgcGVuZGluZ0RhdGEgPSBudWxsO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgdHJhbnNhY3Rpb25zID0gY29udmVydFBhcnNlZERhdGFUb1RyYW5zYWN0aW9ucyhhbGxNb250aHNEYXRhLCBwZW5kaW5nRGF0YSwgdGhpcy5vcHRpb25zKTtcblxuICAgICAgICBkZWJ1ZygnZmlsdGVyIG91dCBvbGQgdHJhbnNhY3Rpb25zJyk7XG4gICAgICAgIGNvbnN0IHR4bnMgPVxuICAgICAgICAgICh0aGlzLm9wdGlvbnMub3V0cHV0RGF0YT8uZW5hYmxlVHJhbnNhY3Rpb25zRmlsdGVyQnlEYXRlID8/IHRydWUpXG4gICAgICAgICAgICA/IGZpbHRlck9sZFRyYW5zYWN0aW9ucyh0cmFuc2FjdGlvbnMsIG1vbWVudChzdGFydERhdGUpLCB0aGlzLm9wdGlvbnMuY29tYmluZUluc3RhbGxtZW50cyB8fCBmYWxzZSlcbiAgICAgICAgICAgIDogdHJhbnNhY3Rpb25zO1xuXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgdHhucyxcbiAgICAgICAgICBiYWxhbmNlOiBmcmFtZT8ubmV4dFRvdGFsRGViaXQgIT0gbnVsbCA/IC1mcmFtZS5uZXh0VG90YWxEZWJpdCA6IHVuZGVmaW5lZCxcbiAgICAgICAgICBhY2NvdW50TnVtYmVyOiBjYXJkLmxhc3Q0RGlnaXRzLFxuICAgICAgICB9IGFzIFRyYW5zYWN0aW9uc0FjY291bnQ7XG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgZGVidWcoJ3JldHVybiB0aGUgc2NyYXBlZCBhY2NvdW50cycpO1xuXG4gICAgZGVidWcoSlNPTi5zdHJpbmdpZnkoYWNjb3VudHMsIG51bGwsIDIpKTtcbiAgICByZXR1cm4ge1xuICAgICAgc3VjY2VzczogdHJ1ZSxcbiAgICAgIGFjY291bnRzLFxuICAgIH07XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgVmlzYUNhbFNjcmFwZXI7XG4iXSwibWFwcGluZ3MiOiI7Ozs7OztBQUFBLElBQUFBLE9BQUEsR0FBQUMsc0JBQUEsQ0FBQUMsT0FBQTtBQUVBLElBQUFDLE1BQUEsR0FBQUQsT0FBQTtBQUNBLElBQUFFLHFCQUFBLEdBQUFGLE9BQUE7QUFDQSxJQUFBRyxNQUFBLEdBQUFILE9BQUE7QUFDQSxJQUFBSSxXQUFBLEdBQUFKLE9BQUE7QUFDQSxJQUFBSyxRQUFBLEdBQUFMLE9BQUE7QUFDQSxJQUFBTSxhQUFBLEdBQUFOLE9BQUE7QUFDQSxJQUFB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UUFDcEU7UUFFQTRJLGFBQWEsQ0FBQ1UsSUFBSSxDQUFDdEgsU0FBUyxDQUFDO01BQy9CO01BRUEsSUFBSVAsV0FBVyxFQUFFMkgsVUFBVSxLQUFLLENBQUMsSUFBSTNILFdBQVcsRUFBRTJILFVBQVUsS0FBSyxFQUFFLEVBQUU7UUFDbkVoTCxLQUFLLENBQ0gsaURBQWlEeUQsSUFBSSxDQUFDdUUsV0FBVyxjQUFjM0UsV0FBVyxFQUFFNEgsS0FBSyxJQUFJLEVBQUUsRUFDekcsQ0FBQztRQUNENUgsV0FBVyxHQUFHLElBQUk7TUFDcEIsQ0FBQyxNQUFNLElBQUksQ0FBQ3JDLCtCQUErQixDQUFDcUMsV0FBVyxDQUFDLEVBQUU7UUFDeERyRCxLQUFLLENBQUMsbURBQW1ELENBQUM7UUFDMURxRCxXQUFXLEdBQUcsSUFBSTtNQUNwQjtNQUVBLE1BQU1nQixZQUFZLEdBQUdsQiwrQkFBK0IsQ0FBQ3FILGFBQWEsRUFBRW5ILFdBQVcsRUFBRSxJQUFJLENBQUNWLE9BQU8sQ0FBQztNQUU5RjNDLEtBQUssQ0FBQyw2QkFBNkIsQ0FBQztNQUNwQyxNQUFNbUwsSUFBSSxHQUNQLElBQUksQ0FBQ3hJLE9BQU8sQ0FBQ3lJLFVBQVUsRUFBRUMsOEJBQThCLElBQUksSUFBSSxHQUM1RCxJQUFBQyxtQ0FBcUIsRUFBQ2pILFlBQVksRUFBRSxJQUFBVSxlQUFNLEVBQUM0RSxTQUFTLENBQUMsRUFBRSxJQUFJLENBQUNoSCxPQUFPLENBQUM0SSxtQkFBbUIsSUFBSSxLQUFLLENBQUMsR0FDakdsSCxZQUFZO01BRWxCLE9BQU87UUFDTDhHLElBQUk7UUFDSkssT0FBTyxFQUFFckssS0FBSyxFQUFFc0ssY0FBYyxJQUFJLElBQUksR0FBRyxDQUFDdEssS0FBSyxDQUFDc0ssY0FBYyxHQUFHOUssU0FBUztRQUMxRStLLGFBQWEsRUFBRWpJLElBQUksQ0FBQ3VFO01BQ3RCLENBQUM7SUFDSCxDQUFDLENBQ0gsQ0FBQztJQUVEaEksS0FBSyxDQUFDLDZCQUE2QixDQUFDO0lBRXBDQSxLQUFLLENBQUMyTCxJQUFJLENBQUNDLFNBQVMsQ0FBQzlILFFBQVEsRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUM7SUFDeEMsT0FBTztNQUNMK0gsT0FBTyxFQUFFLElBQUk7TUFDYi9IO0lBQ0YsQ0FBQztFQUNIO0FBQ0Y7QUFBQyxJQUFBZ0ksUUFBQSxHQUFBQyxPQUFBLENBQUExTSxPQUFBLEdBRWNnSSxjQUFjIiwiaWdub3JlTGlzdCI6W119