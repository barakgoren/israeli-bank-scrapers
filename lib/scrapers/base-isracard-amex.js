"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _moment = _interopRequireDefault(require("moment"));
var _constants = require("../constants");
var _definitions = require("../definitions");
var _dates = _interopRequireDefault(require("../helpers/dates"));
var _debug = require("../helpers/debug");
var _fetch = require("../helpers/fetch");
var _arrays = require("../helpers/arrays");
var _transactions = require("../helpers/transactions");
var _waiting = require("../helpers/waiting");
var _transactions2 = require("../transactions");
var _baseScraperWithBrowser = require("./base-scraper-with-browser");
var _errors = require("./errors");
var _browser = require("../helpers/browser");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
const RATE_LIMIT = {
  SLEEP_BETWEEN: 1000,
  TRANSACTIONS_BATCH_SIZE: 10
};
const COUNTRY_CODE = '212';
const ID_TYPE = '1';
const INSTALLMENTS_KEYWORD = 'תשלום';
const DATE_FORMAT = 'DD/MM/YYYY';
const debug = (0, _debug.getDebug)('base-isracard-amex');
function getAccountsUrl(servicesUrl, monthMoment) {
  const billingDate = monthMoment.format('YYYY-MM-DD');
  const url = new URL(servicesUrl);
  url.searchParams.set('reqName', 'DashboardMonth');
  url.searchParams.set('actionCode', '0');
  url.searchParams.set('billingDate', billingDate);
  url.searchParams.set('format', 'Json');
  return url.toString();
}
async function fetchAccounts(page, servicesUrl, monthMoment) {
  const dataUrl = getAccountsUrl(servicesUrl, monthMoment);
  debug(`fetching accounts from ${dataUrl}`);
  const dataResult = await (0, _fetch.fetchGetWithinPage)(page, dataUrl);
  if (dataResult && dataResult.Header?.Status === '1' && dataResult.DashboardMonthBean) {
    const {
      cardsCharges
    } = dataResult.DashboardMonthBean;
    if (cardsCharges) {
      return cardsCharges.map(cardCharge => {
        return {
          index: parseInt(cardCharge.cardIndex, 10),
          accountNumber: cardCharge.cardNumber,
          processedDate: (0, _moment.default)(cardCharge.billingDate, DATE_FORMAT).toISOString(),
          period: cardCharge.period,
          billingTotal: parseFloat(cardCharge.billingSumSekel)
        };
      });
    }
  }
  return [];
}
function getTransactionsUrl(servicesUrl, monthMoment) {
  const month = monthMoment.month() + 1;
  const year = monthMoment.year();
  const monthStr = month < 10 ? `0${month}` : month.toString();
  const url = new URL(servicesUrl);
  url.searchParams.set('reqName', 'CardsTransactionsList');
  url.searchParams.set('month', monthStr);
  url.searchParams.set('year', `${year}`);
  url.searchParams.set('requiredDate', 'N');
  return url.toString();
}
function convertCurrency(currencyStr) {
  if (currencyStr === _constants.SHEKEL_CURRENCY_KEYWORD || currencyStr === _constants.ALT_SHEKEL_CURRENCY) {
    return _constants.SHEKEL_CURRENCY;
  }
  return currencyStr;
}
function getInstallmentsInfo(txn) {
  if (!txn.moreInfo || !txn.moreInfo.includes(INSTALLMENTS_KEYWORD)) {
    return undefined;
  }
  const matches = txn.moreInfo.match(/\d+/g);
  if (!matches || matches.length < 2) {
    return undefined;
  }
  return {
    number: parseInt(matches[0], 10),
    total: parseInt(matches[1], 10)
  };
}
function getTransactionType(txn) {
  return getInstallmentsInfo(txn) ? _transactions2.TransactionTypes.Installments : _transactions2.TransactionTypes.Normal;
}
function convertTransactions(txns, processedDate, options) {
  const filteredTxns = txns.filter(txn => txn.dealSumType !== '1' && txn.voucherNumberRatz !== '000000000' && txn.voucherNumberRatzOutbound !== '000000000');
  return filteredTxns.map(txn => {
    const isOutbound = txn.dealSumOutbound;
    const txnDateStr = isOutbound ? txn.fullPurchaseDateOutbound : txn.fullPurchaseDate;
    const txnMoment = (0, _moment.default)(txnDateStr, DATE_FORMAT);
    const currentProcessedDate = txn.fullPaymentDate ? (0, _moment.default)(txn.fullPaymentDate, DATE_FORMAT).toISOString() : processedDate;
    const result = {
      type: getTransactionType(txn),
      identifier: parseInt(isOutbound ? txn.voucherNumberRatzOutbound : txn.voucherNumberRatz, 10),
      date: txnMoment.toISOString(),
      processedDate: currentProcessedDate,
      billingDate: processedDate,
      originalAmount: isOutbound ? -txn.dealSumOutbound : -txn.dealSum,
      originalCurrency: convertCurrency(txn.currentPaymentCurrency ?? txn.currencyId),
      chargedAmount: isOutbound ? -txn.paymentSumOutbound : -txn.paymentSum,
      chargedCurrency: convertCurrency(txn.currencyId),
      description: isOutbound ? txn.fullSupplierNameOutbound : txn.fullSupplierNameHeb,
      memo: txn.moreInfo || '',
      installments: getInstallmentsInfo(txn) || undefined,
      status: _transactions2.TransactionStatuses.Completed
    };
    if (options?.includeRawTransaction) {
      result.rawTransaction = (0, _transactions.getRawTransaction)(txn);
    }
    return result;
  });
}
async function fetchTransactions(page, options, companyServiceOptions, startMoment, monthMoment) {
  const accounts = await fetchAccounts(page, companyServiceOptions.servicesUrl, monthMoment);
  const dataUrl = getTransactionsUrl(companyServiceOptions.servicesUrl, monthMoment);
  await (0, _waiting.sleep)(RATE_LIMIT.SLEEP_BETWEEN);
  debug(`fetching transactions from ${dataUrl} for month ${monthMoment.format('YYYY-MM')}`);
  const dataResult = await (0, _fetch.fetchGetWithinPage)(page, dataUrl);
  if (dataResult && dataResult.Header?.Status === '1' && dataResult.CardsTransactionsListBean) {
    const accountTxns = {};
    accounts.forEach(account => {
      const billingPeriod = {
        billingDate: account.processedDate,
        status: account.period === 'Next' ? 'current' : 'previous',
        total: account.billingTotal
      };
      const txnGroups = dataResult.CardsTransactionsListBean?.[`Index${account.index}`]?.CurrentCardTransactions;
      let allTxns = [];
      if (txnGroups) {
        txnGroups.forEach(txnGroup => {
          if (txnGroup.txnIsrael) {
            allTxns.push(...convertTransactions(txnGroup.txnIsrael, account.processedDate, options));
          }
          if (txnGroup.txnAbroad) {
            allTxns.push(...convertTransactions(txnGroup.txnAbroad, account.processedDate, options));
          }
        });
        if (!options.combineInstallments) {
          allTxns = (0, _transactions.fixInstallments)(allTxns);
        }
        if (options.outputData?.enableTransactionsFilterByDate ?? true) {
          allTxns = (0, _transactions.filterOldTransactions)(allTxns, startMoment, options.combineInstallments || false);
        }
      }
      if (accountTxns[account.accountNumber]) {
        accountTxns[account.accountNumber].txns.push(...allTxns);
        accountTxns[account.accountNumber].billingPeriods.push(billingPeriod);
      } else {
        accountTxns[account.accountNumber] = {
          accountNumber: account.accountNumber,
          index: account.index,
          txns: allTxns,
          billingPeriods: [billingPeriod]
        };
      }
    });
    return accountTxns;
  }
  return {};
}
async function getExtraScrapTransaction(page, options, month, accountIndex, transaction) {
  const url = new URL(options.servicesUrl);
  url.searchParams.set('reqName', 'PirteyIska_204');
  url.searchParams.set('CardIndex', accountIndex.toString());
  url.searchParams.set('shovarRatz', transaction.identifier.toString());
  url.searchParams.set('moedChiuv', month.format('MMYYYY'));
  debug(`fetching extra scrap for transaction ${transaction.identifier} for month ${month.format('YYYY-MM')}`);
  const data = await (0, _fetch.fetchGetWithinPage)(page, url.toString());
  if (!data) {
    return transaction;
  }
  const rawCategory = data.PirteyIska_204Bean?.sector ?? '';
  return {
    ...transaction,
    category: rawCategory.trim(),
    rawTransaction: (0, _transactions.getRawTransaction)(data, transaction)
  };
}
async function getExtraScrapAccount(page, options, accountMap, month) {
  const accounts = [];
  for (const account of Object.values(accountMap)) {
    debug(`get extra scrap for ${account.accountNumber} with ${account.txns.length} transactions`, month.format('YYYY-MM'));
    const txns = [];
    for (const txnsChunk of (0, _arrays.chunk)(account.txns, RATE_LIMIT.TRANSACTIONS_BATCH_SIZE)) {
      debug(`processing chunk of ${txnsChunk.length} transactions for account ${account.accountNumber}`);
      const updatedTxns = await Promise.all(txnsChunk.map(t => getExtraScrapTransaction(page, options, month, account.index, t)));
      await (0, _waiting.sleep)(RATE_LIMIT.SLEEP_BETWEEN);
      txns.push(...updatedTxns);
    }
    accounts.push({
      ...account,
      txns
    });
  }
  return accounts.reduce((m, x) => ({
    ...m,
    [x.accountNumber]: x
  }), {});
}
async function getAdditionalTransactionInformation(scraperOptions, accountsWithIndex, page, options, allMonths) {
  if (!scraperOptions.additionalTransactionInformation || scraperOptions.optInFeatures?.includes('isracard-amex:skipAdditionalTransactionInformation')) {
    return accountsWithIndex;
  }
  return (0, _waiting.runSerial)(accountsWithIndex.map((a, i) => () => getExtraScrapAccount(page, options, a, allMonths[i])));
}
async function fetchAllTransactions(page, options, companyServiceOptions, startMoment) {
  const futureMonthsToScrape = options.futureMonthsToScrape ?? 1;
  const allMonths = (0, _dates.default)(startMoment, futureMonthsToScrape);
  const results = await (0, _waiting.runSerial)(allMonths.map(monthMoment => () => {
    return fetchTransactions(page, options, companyServiceOptions, startMoment, monthMoment);
  }));
  debug({
    page
  });
  const finalResult = await getAdditionalTransactionInformation(options, results, page, companyServiceOptions, allMonths);
  const combinedTxns = {};
  const combinedBillingPeriods = {};
  finalResult.forEach(result => {
    Object.keys(result).forEach(accountNumber => {
      if (!combinedTxns[accountNumber]) {
        combinedTxns[accountNumber] = [];
      }
      combinedTxns[accountNumber].push(...result[accountNumber].txns);
      if (!combinedBillingPeriods[accountNumber]) {
        combinedBillingPeriods[accountNumber] = [];
      }
      combinedBillingPeriods[accountNumber].push(...(result[accountNumber].billingPeriods ?? []));
    });
  });
  const allAccountNumbers = new Set([...Object.keys(combinedTxns), ...Object.keys(combinedBillingPeriods)]);
  const accounts = Array.from(allAccountNumbers).map(accountNumber => {
    return {
      accountNumber,
      txns: combinedTxns[accountNumber] ?? [],
      billingPeriods: combinedBillingPeriods[accountNumber]
    };
  });
  return {
    success: true,
    accounts
  };
}
class IsracardAmexBaseScraper extends _baseScraperWithBrowser.BaseScraperWithBrowser {
  constructor(options, baseUrl, companyCode) {
    super(options);
    this.baseUrl = baseUrl;
    this.companyCode = companyCode;
    this.servicesUrl = `${baseUrl}/services/ProxyRequestHandler.ashx`;
  }
  async login(credentials) {
    await this.page.setRequestInterception(true);
    this.page.on('request', request => {
      if (request.url().includes('detector-dom.min.js')) {
        debug('force abort for request do download detector-dom.min.js resource');
        void request.abort(undefined, _browser.interceptionPriorities.abort);
      } else {
        void request.continue(undefined, _browser.interceptionPriorities.continue);
      }
    });
    await (0, _browser.maskHeadlessUserAgent)(this.page);
    await this.navigateTo(`${this.baseUrl}/personalarea/Login`);
    this.emitProgress(_definitions.ScraperProgressTypes.LoggingIn);
    const validateUrl = `${this.servicesUrl}?reqName=ValidateIdData`;
    const validateRequest = {
      id: credentials.id,
      cardSuffix: credentials.card6Digits,
      countryCode: COUNTRY_CODE,
      idType: ID_TYPE,
      checkLevel: '1',
      companyCode: this.companyCode
    };
    debug('logging in with validate request');
    const validateResult = await (0, _fetch.fetchPostWithinPage)(this.page, validateUrl, validateRequest);
    if (!validateResult || !validateResult.Header || validateResult.Header.Status !== '1' || !validateResult.ValidateIdDataBean) {
      throw new Error('unknown error during login');
    }
    const validateReturnCode = validateResult.ValidateIdDataBean.returnCode;
    debug(`user validate with return code '${validateReturnCode}'`);
    if (validateReturnCode === '1') {
      const {
        userName
      } = validateResult.ValidateIdDataBean;
      const loginUrl = `${this.servicesUrl}?reqName=performLogonI`;
      const request = {
        KodMishtamesh: userName,
        MisparZihuy: credentials.id,
        Sisma: credentials.password,
        cardSuffix: credentials.card6Digits,
        countryCode: COUNTRY_CODE,
        idType: ID_TYPE
      };
      debug('user login started');
      const loginResult = await (0, _fetch.fetchPostWithinPage)(this.page, loginUrl, request);
      debug(`user login with status '${loginResult?.status}'`, loginResult);
      if (loginResult && loginResult.status === '1') {
        this.emitProgress(_definitions.ScraperProgressTypes.LoginSuccess);
        return {
          success: true
        };
      }
      if (loginResult && loginResult.status === '3') {
        this.emitProgress(_definitions.ScraperProgressTypes.ChangePassword);
        return {
          success: false,
          errorType: _errors.ScraperErrorTypes.ChangePassword
        };
      }
      this.emitProgress(_definitions.ScraperProgressTypes.LoginFailed);
      return {
        success: false,
        errorType: _errors.ScraperErrorTypes.InvalidPassword
      };
    }
    if (validateReturnCode === '4') {
      this.emitProgress(_definitions.ScraperProgressTypes.ChangePassword);
      return {
        success: false,
        errorType: _errors.ScraperErrorTypes.ChangePassword
      };
    }
    this.emitProgress(_definitions.ScraperProgressTypes.LoginFailed);
    return {
      success: false,
      errorType: _errors.ScraperErrorTypes.InvalidPassword
    };
  }
  async fetchData() {
    const defaultStartMoment = (0, _moment.default)().subtract(1, 'years');
    const startDate = this.options.startDate || defaultStartMoment.toDate();
    const startMoment = _moment.default.max(defaultStartMoment, (0, _moment.default)(startDate));
    return fetchAllTransactions(this.page, this.options, {
      servicesUrl: this.servicesUrl,
      companyCode: this.companyCode
    }, startMoment);
  }
}
var _default = exports.default = IsracardAmexBaseScraper;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbW9tZW50IiwiX2ludGVyb3BSZXF1aXJlRGVmYXVsdCIsInJlcXVpcmUiLCJfY29uc3RhbnRzIiwiX2RlZmluaXRpb25zIiwiX2RhdGVzIiwiX2RlYnVnIiwiX2ZldGNoIiwiX2FycmF5cyIsIl90cmFuc2FjdGlvbnMiLCJfd2FpdGluZyIsIl90cmFuc2FjdGlvbnMyIiwiX2Jhc2VTY3JhcGVyV2l0aEJyb3dzZXIiLCJfZXJyb3JzIiwiX2Jyb3dzZXIiLCJlIiwiX19lc01vZHVsZSIsImRlZmF1bHQiLCJSQVRFX0xJTUlUIiwiU0xFRVBfQkVUV0VFTiIsIlRSQU5TQUNUSU9OU19CQVRDSF9TSVpFIiwiQ09VTlRSWV9DT0RFIiwiSURfVFlQRSIsIklOU1RBTExNRU5UU19LRVlXT1JEIiwiREFURV9GT1JNQVQiLCJkZWJ1ZyIsImdldERlYnVnIiwiZ2V0QWNjb3VudHNVcmwiLCJzZXJ2aWNlc1VybCIsIm1vbnRoTW9tZW50IiwiYmlsbGluZ0RhdGUiLCJmb3JtYXQiLCJ1cmwiLCJVUkwiLCJzZWFyY2hQYXJhbXMiLCJzZXQiLCJ0b1N0cmluZyIsImZldGNoQWNjb3VudHMiLCJwYWdlIiwiZGF0YVVybCIsImRhdGFSZXN1bHQiLCJmZXRjaEdldFdpdGhpblBhZ2UiLCJIZWFkZXIiLCJTdGF0dXMiLCJEYXNoYm9hcmRNb250aEJlYW4iLCJjYXJkc0NoYXJnZXMiLCJtYXAiLCJjYXJkQ2hhcmdlIiwiaW5kZXgiLCJwYXJzZUludCIsImNhcmRJbmRleCIsImFjY291bnROdW1iZXIiLCJjYXJkTnVtYmVyIiwicHJvY2Vzc2VkRGF0ZSIsIm1vbWVudCIsInRvSVNPU3RyaW5nIiwicGVyaW9kIiwiYmlsbGluZ1RvdGFsIiwicGFyc2VGbG9hdCIsImJpbGxpbmdTdW1TZWtlbCIsImdldFRyYW5zYWN0aW9uc1VybCIsIm1vbnRoIiwieWVhciIsIm1vbnRoU3RyIiwiY29udmVydEN1cnJlbmN5IiwiY3VycmVuY3lTdHIiLCJTSEVLRUxfQ1VSUkVOQ1lfS0VZV09SRCIsIkFMVF9TSEVLRUxfQ1VSUkVOQ1kiLCJTSEVLRUxfQ1VSUkVOQ1kiLCJnZXRJbnN0YWxsbWVudHNJbmZvIiwidHhuIiwibW9yZUluZm8iLCJpbmNsdWRlcyIsInVuZGVmaW5lZCIsIm1hdGNoZXMiLCJtYXRjaCIsImxlbmd0aCIsIm51bWJlciIsInRvdGFsIiwiZ2V0VHJhbnNhY3Rpb25UeXBlIiwiVHJhbnNhY3Rpb25UeXBlcyIsIkluc3RhbGxtZW50cyIsIk5vcm1hbCIsImNvbnZlcnRUcmFuc2FjdGlvbnMiLCJ0eG5zIiwib3B0aW9ucyIsImZpbHRlcmVkVHhucyIsImZpbHRlciIsImRlYWxTdW1UeXBlIiwidm91Y2hlck51bWJlclJhdHoiLCJ2b3VjaGVyTnVtYmVyUmF0ek91dGJvdW5kIiwiaXNPdXRib3VuZCIsImRlYWxTdW1PdXRib3VuZCIsInR4bkRhdGVTdHIiLCJmdWxsUHVyY2hhc2VEYXRlT3V0Ym91bmQiLCJmdWxsUHVyY2hhc2VEYXRlIiwidHhuTW9tZW50IiwiY3VycmVudFByb2Nlc3NlZERhdGUiLCJmdWxsUGF5bWVudERhdGUiLCJyZXN1bHQiLCJ0eXBlIiwiaWRlbnRpZmllciIsImRhdGUiLCJvcmlnaW5hbEFtb3VudCIsImRlYWxTdW0iLCJvcmlnaW5hbEN1cnJlbmN5IiwiY3VycmVudFBheW1lbnRDdXJyZW5jeSIsImN1cnJlbmN5SWQiLCJjaGFyZ2VkQW1vdW50IiwicGF5bWVudFN1bU91dGJvdW5kIiwicGF5bWVudFN1bSIsImNoYXJnZWRDdXJyZW5jeSIsImRlc2NyaXB0aW9uIiwiZnVsbFN1cHBsaWVyTmFtZU91dGJvdW5kIiwiZnVsbFN1cHBsaWVyTmFtZUhlYiIsIm1lbW8iLCJpbnN0YWxsbWVudHMiLCJzdGF0dXMiLCJUcmFuc2FjdGlvblN0YXR1c2VzIiwiQ29tcGxldGVkIiwiaW5jbHVkZVJhd1RyYW5zYWN0aW9uIiwicmF3VHJhbnNhY3Rpb24iLCJnZXRSYXdUcmFuc2FjdGlvbiIsImZldGNoVHJhbnNhY3Rpb25zIiwiY29tcGFueVNlcnZpY2VPcHRpb25zIiwic3RhcnRNb21lbnQiLCJhY2NvdW50cyIsInNsZWVwIiwiQ2FyZHNUcmFuc2FjdGlvbnNMaXN0QmVhbiIsImFjY291bnRUeG5zIiwiZm9yRWFjaCIsImFjY291bnQiLCJiaWxsaW5nUGVyaW9kIiwidHhuR3JvdXBzIiwiQ3VycmVudENhcmRUcmFuc2FjdGlvbnMiLCJhbGxUeG5zIiwidHhuR3JvdXAiLCJ0eG5Jc3JhZWwiLCJwdXNoIiwidHhuQWJyb2FkIiwiY29tYmluZUluc3RhbGxtZW50cyIsImZpeEluc3RhbGxtZW50cyIsIm91dHB1dERhdGEiLCJlbmFibGVUcmFuc2FjdGlvbnNGaWx0ZXJCeURhdGUiLCJmaWx0ZXJPbGRUcmFuc2FjdGlvbnMiLCJiaWxsaW5nUGVyaW9kcyIsImdldEV4dHJhU2NyYXBUcmFuc2FjdGlvbiIsImFjY291bnRJbmRleCIsInRyYW5zYWN0aW9uIiwiZGF0YSIsInJhd0NhdGVnb3J5IiwiUGlydGV5SXNrYV8yMDRCZWFuIiwic2VjdG9yIiwiY2F0ZWdvcnkiLCJ0cmltIiwiZ2V0RXh0cmFTY3JhcEFjY291bnQiLCJhY2NvdW50TWFwIiwiT2JqZWN0IiwidmFsdWVzIiwidHhuc0NodW5rIiwiY2h1bmsiLCJ1cGRhdGVkVHhucyIsIlByb21pc2UiLCJhbGwiLCJ0IiwicmVkdWNlIiwibSIsIngiLCJnZXRBZGRpdGlvbmFsVHJhbnNhY3Rpb25JbmZvcm1hdGlvbiIsInNjcmFwZXJPcHRpb25zIiwiYWNjb3VudHNXaXRoSW5kZXgiLCJhbGxNb250aHMiLCJhZGRpdGlvbmFsVHJhbnNhY3Rpb25JbmZvcm1hdGlvbiIsIm9wdEluRmVhdHVyZXMiLCJydW5TZXJpYWwiLCJhIiwiaSIsImZldGNoQWxsVHJhbnNhY3Rpb25zIiwiZnV0dXJlTW9udGhzVG9TY3JhcGUiLCJnZXRBbGxNb250aE1vbWVudHMiLCJyZXN1bHRzIiwiZmluYWxSZXN1bHQiLCJjb21iaW5lZFR4bnMiLCJjb21iaW5lZEJpbGxpbmdQZXJpb2RzIiwia2V5cyIsImFsbEFjY291bnROdW1iZXJzIiwiU2V0IiwiQXJyYXkiLCJmcm9tIiwic3VjY2VzcyIsIklzcmFjYXJkQW1leEJhc2VTY3JhcGVyIiwiQmFzZVNjcmFwZXJXaXRoQnJvd3NlciIsImNvbnN0cnVjdG9yIiwiYmFzZVVybCIsImNvbXBhbnlDb2RlIiwibG9naW4iLCJjcmVkZW50aWFscyIsInNldFJlcXVlc3RJbnRlcmNlcHRpb24iLCJvbiIsInJlcXVlc3QiLCJhYm9ydCIsImludGVyY2VwdGlvblByaW9yaXRpZXMiLCJjb250aW51ZSIsIm1hc2tIZWFkbGVzc1VzZXJBZ2VudCIsIm5hdmlnYXRlVG8iLCJlbWl0UHJvZ3Jlc3MiLCJTY3JhcGVyUHJvZ3Jlc3NUeXBlcyIsIkxvZ2dpbmdJbiIsInZhbGlkYXRlVXJsIiwidmFsaWRhdGVSZXF1ZXN0IiwiaWQiLCJjYXJkU3VmZml4IiwiY2FyZDZEaWdpdHMiLCJjb3VudHJ5Q29kZSIsImlkVHlwZSIsImNoZWNrTGV2ZWwiLCJ2YWxpZGF0ZVJlc3VsdCIsImZldGNoUG9zdFdpdGhpblBhZ2UiLCJWYWxpZGF0ZUlkRGF0YUJlYW4iLCJFcnJvciIsInZhbGlkYXRlUmV0dXJuQ29kZSIsInJldHVybkNvZGUiLCJ1c2VyTmFtZSIsImxvZ2luVXJsIiwiS29kTWlzaHRhbWVzaCIsIk1pc3BhclppaHV5IiwiU2lzbWEiLCJwYXNzd29yZCIsImxvZ2luUmVzdWx0IiwiTG9naW5TdWNjZXNzIiwiQ2hhbmdlUGFzc3dvcmQiLCJlcnJvclR5cGUiLCJTY3JhcGVyRXJyb3JUeXBlcyIsIkxvZ2luRmFpbGVkIiwiSW52YWxpZFBhc3N3b3JkIiwiZmV0Y2hEYXRhIiwiZGVmYXVsdFN0YXJ0TW9tZW50Iiwic3VidHJhY3QiLCJzdGFydERhdGUiLCJ0b0RhdGUiLCJtYXgiLCJfZGVmYXVsdCIsImV4cG9ydHMiXSwic291cmNlcyI6WyIuLi8uLi9zcmMvc2NyYXBlcnMvYmFzZS1pc3JhY2FyZC1hbWV4LnRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBtb21lbnQsIHsgdHlwZSBNb21lbnQgfSBmcm9tICdtb21lbnQnO1xuaW1wb3J0IHsgdHlwZSBQYWdlIH0gZnJvbSAncHVwcGV0ZWVyJztcbmltcG9ydCB7IEFMVF9TSEVLRUxfQ1VSUkVOQ1ksIFNIRUtFTF9DVVJSRU5DWSwgU0hFS0VMX0NVUlJFTkNZX0tFWVdPUkQgfSBmcm9tICcuLi9jb25zdGFudHMnO1xuaW1wb3J0IHsgU2NyYXBlclByb2dyZXNzVHlwZXMgfSBmcm9tICcuLi9kZWZpbml0aW9ucyc7XG5pbXBvcnQgZ2V0QWxsTW9udGhNb21lbnRzIGZyb20gJy4uL2hlbHBlcnMvZGF0ZXMnO1xuaW1wb3J0IHsgZ2V0RGVidWcgfSBmcm9tICcuLi9oZWxwZXJzL2RlYnVnJztcbmltcG9ydCB7IGZldGNoR2V0V2l0aGluUGFnZSwgZmV0Y2hQb3N0V2l0aGluUGFnZSB9IGZyb20gJy4uL2hlbHBlcnMvZmV0Y2gnO1xuaW1wb3J0IHsgY2h1bmsgfSBmcm9tICcuLi9oZWxwZXJzL2FycmF5cyc7XG5pbXBvcnQgeyBmaWx0ZXJPbGRUcmFuc2FjdGlvbnMsIGZpeEluc3RhbGxtZW50cywgZ2V0UmF3VHJhbnNhY3Rpb24gfSBmcm9tICcuLi9oZWxwZXJzL3RyYW5zYWN0aW9ucyc7XG5pbXBvcnQgeyBydW5TZXJpYWwsIHNsZWVwIH0gZnJvbSAnLi4vaGVscGVycy93YWl0aW5nJztcbmltcG9ydCB7XG4gIFRyYW5zYWN0aW9uU3RhdHVzZXMsXG4gIFRyYW5zYWN0aW9uVHlwZXMsXG4gIHR5cGUgQmlsbGluZ1BlcmlvZCxcbiAgdHlwZSBUcmFuc2FjdGlvbixcbiAgdHlwZSBUcmFuc2FjdGlvbkluc3RhbGxtZW50cyxcbiAgdHlwZSBUcmFuc2FjdGlvbnNBY2NvdW50LFxufSBmcm9tICcuLi90cmFuc2FjdGlvbnMnO1xuaW1wb3J0IHsgQmFzZVNjcmFwZXJXaXRoQnJvd3NlciB9IGZyb20gJy4vYmFzZS1zY3JhcGVyLXdpdGgtYnJvd3Nlcic7XG5pbXBvcnQgeyBTY3JhcGVyRXJyb3JUeXBlcyB9IGZyb20gJy4vZXJyb3JzJztcbmltcG9ydCB7IHR5cGUgU2NyYXBlck9wdGlvbnMsIHR5cGUgU2NyYXBlclNjcmFwaW5nUmVzdWx0IH0gZnJvbSAnLi9pbnRlcmZhY2UnO1xuaW1wb3J0IHsgaW50ZXJjZXB0aW9uUHJpb3JpdGllcywgbWFza0hlYWRsZXNzVXNlckFnZW50IH0gZnJvbSAnLi4vaGVscGVycy9icm93c2VyJztcblxuY29uc3QgUkFURV9MSU1JVCA9IHtcbiAgU0xFRVBfQkVUV0VFTjogMTAwMCxcbiAgVFJBTlNBQ1RJT05TX0JBVENIX1NJWkU6IDEwLFxufSBhcyBjb25zdDtcblxuY29uc3QgQ09VTlRSWV9DT0RFID0gJzIxMic7XG5jb25zdCBJRF9UWVBFID0gJzEnO1xuY29uc3QgSU5TVEFMTE1FTlRTX0tFWVdPUkQgPSAn16rXqdec15XXnSc7XG5cbmNvbnN0IERBVEVfRk9STUFUID0gJ0REL01NL1lZWVknO1xuXG5jb25zdCBkZWJ1ZyA9IGdldERlYnVnKCdiYXNlLWlzcmFjYXJkLWFtZXgnKTtcblxudHlwZSBDb21wYW55U2VydmljZU9wdGlvbnMgPSB7XG4gIHNlcnZpY2VzVXJsOiBzdHJpbmc7XG4gIGNvbXBhbnlDb2RlOiBzdHJpbmc7XG59O1xuXG50eXBlIFNjcmFwZWRBY2NvdW50c1dpdGhJbmRleCA9IFJlY29yZDxzdHJpbmcsIFRyYW5zYWN0aW9uc0FjY291bnQgJiB7IGluZGV4OiBudW1iZXIgfT47XG5cbmludGVyZmFjZSBTY3JhcGVkVHJhbnNhY3Rpb24ge1xuICBkZWFsU3VtVHlwZTogc3RyaW5nO1xuICB2b3VjaGVyTnVtYmVyUmF0ek91dGJvdW5kOiBzdHJpbmc7XG4gIHZvdWNoZXJOdW1iZXJSYXR6OiBzdHJpbmc7XG4gIG1vcmVJbmZvPzogc3RyaW5nO1xuICBkZWFsU3VtT3V0Ym91bmQ6IGJvb2xlYW47XG4gIGN1cnJlbmN5SWQ6IHN0cmluZztcbiAgY3VycmVudFBheW1lbnRDdXJyZW5jeTogc3RyaW5nO1xuICBkZWFsU3VtOiBudW1iZXI7XG4gIGZ1bGxQYXltZW50RGF0ZT86IHN0cmluZztcbiAgZnVsbFB1cmNoYXNlRGF0ZT86IHN0cmluZztcbiAgZnVsbFB1cmNoYXNlRGF0ZU91dGJvdW5kPzogc3RyaW5nO1xuICBmdWxsU3VwcGxpZXJOYW1lSGViOiBzdHJpbmc7XG4gIGZ1bGxTdXBwbGllck5hbWVPdXRib3VuZDogc3RyaW5nO1xuICBwYXltZW50U3VtOiBudW1iZXI7XG4gIHBheW1lbnRTdW1PdXRib3VuZDogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgU2NyYXBlZEFjY291bnQge1xuICBpbmRleDogbnVtYmVyO1xuICBhY2NvdW50TnVtYmVyOiBzdHJpbmc7XG4gIHByb2Nlc3NlZERhdGU6IHN0cmluZztcbiAgcGVyaW9kOiBzdHJpbmc7XG4gIGJpbGxpbmdUb3RhbDogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgU2NyYXBlZExvZ2luVmFsaWRhdGlvbiB7XG4gIEhlYWRlcjoge1xuICAgIFN0YXR1czogc3RyaW5nO1xuICB9O1xuICBWYWxpZGF0ZUlkRGF0YUJlYW4/OiB7XG4gICAgdXNlck5hbWU/OiBzdHJpbmc7XG4gICAgcmV0dXJuQ29kZTogc3RyaW5nO1xuICB9O1xufVxuXG5pbnRlcmZhY2UgU2NyYXBlZEFjY291bnRzV2l0aGluUGFnZVJlc3BvbnNlIHtcbiAgSGVhZGVyOiB7XG4gICAgU3RhdHVzOiBzdHJpbmc7XG4gIH07XG4gIERhc2hib2FyZE1vbnRoQmVhbj86IHtcbiAgICBjYXJkc0NoYXJnZXM6IHtcbiAgICAgIGNhcmRJbmRleDogc3RyaW5nO1xuICAgICAgY2FyZE51bWJlcjogc3RyaW5nO1xuICAgICAgYmlsbGluZ0RhdGU6IHN0cmluZztcbiAgICAgIHBlcmlvZDogc3RyaW5nO1xuICAgICAgYmlsbGluZ1N1bVNla2VsOiBzdHJpbmc7XG4gICAgfVtdO1xuICB9O1xufVxuXG5pbnRlcmZhY2UgU2NyYXBlZEN1cnJlbnRDYXJkVHJhbnNhY3Rpb25zIHtcbiAgdHhuSXNyYWVsPzogU2NyYXBlZFRyYW5zYWN0aW9uW107XG4gIHR4bkFicm9hZD86IFNjcmFwZWRUcmFuc2FjdGlvbltdO1xufVxuXG5pbnRlcmZhY2UgU2NyYXBlZFRyYW5zYWN0aW9uRGF0YSB7XG4gIEhlYWRlcj86IHtcbiAgICBTdGF0dXM6IHN0cmluZztcbiAgfTtcbiAgUGlydGV5SXNrYV8yMDRCZWFuPzoge1xuICAgIHNlY3Rvcjogc3RyaW5nO1xuICB9O1xuXG4gIENhcmRzVHJhbnNhY3Rpb25zTGlzdEJlYW4/OiBSZWNvcmQ8XG4gICAgc3RyaW5nLFxuICAgIHtcbiAgICAgIEN1cnJlbnRDYXJkVHJhbnNhY3Rpb25zOiBTY3JhcGVkQ3VycmVudENhcmRUcmFuc2FjdGlvbnNbXTtcbiAgICB9XG4gID47XG59XG5cbmZ1bmN0aW9uIGdldEFjY291bnRzVXJsKHNlcnZpY2VzVXJsOiBzdHJpbmcsIG1vbnRoTW9tZW50OiBNb21lbnQpIHtcbiAgY29uc3QgYmlsbGluZ0RhdGUgPSBtb250aE1vbWVudC5mb3JtYXQoJ1lZWVktTU0tREQnKTtcbiAgY29uc3QgdXJsID0gbmV3IFVSTChzZXJ2aWNlc1VybCk7XG4gIHVybC5zZWFyY2hQYXJhbXMuc2V0KCdyZXFOYW1lJywgJ0Rhc2hib2FyZE1vbnRoJyk7XG4gIHVybC5zZWFyY2hQYXJhbXMuc2V0KCdhY3Rpb25Db2RlJywgJzAnKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ2JpbGxpbmdEYXRlJywgYmlsbGluZ0RhdGUpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgnZm9ybWF0JywgJ0pzb24nKTtcbiAgcmV0dXJuIHVybC50b1N0cmluZygpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBmZXRjaEFjY291bnRzKHBhZ2U6IFBhZ2UsIHNlcnZpY2VzVXJsOiBzdHJpbmcsIG1vbnRoTW9tZW50OiBNb21lbnQpOiBQcm9taXNlPFNjcmFwZWRBY2NvdW50W10+IHtcbiAgY29uc3QgZGF0YVVybCA9IGdldEFjY291bnRzVXJsKHNlcnZpY2VzVXJsLCBtb250aE1vbWVudCk7XG4gIGRlYnVnKGBmZXRjaGluZyBhY2NvdW50cyBmcm9tICR7ZGF0YVVybH1gKTtcbiAgY29uc3QgZGF0YVJlc3VsdCA9IGF3YWl0IGZldGNoR2V0V2l0aGluUGFnZTxTY3JhcGVkQWNjb3VudHNXaXRoaW5QYWdlUmVzcG9uc2U+KHBhZ2UsIGRhdGFVcmwpO1xuICBpZiAoZGF0YVJlc3VsdCAmJiBkYXRhUmVzdWx0LkhlYWRlcj8uU3RhdHVzID09PSAnMScgJiYgZGF0YVJlc3VsdC5EYXNoYm9hcmRNb250aEJlYW4pIHtcbiAgICBjb25zdCB7IGNhcmRzQ2hhcmdlcyB9ID0gZGF0YVJlc3VsdC5EYXNoYm9hcmRNb250aEJlYW47XG4gICAgaWYgKGNhcmRzQ2hhcmdlcykge1xuICAgICAgcmV0dXJuIGNhcmRzQ2hhcmdlcy5tYXAoY2FyZENoYXJnZSA9PiB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgaW5kZXg6IHBhcnNlSW50KGNhcmRDaGFyZ2UuY2FyZEluZGV4LCAxMCksXG4gICAgICAgICAgYWNjb3VudE51bWJlcjogY2FyZENoYXJnZS5jYXJkTnVtYmVyLFxuICAgICAgICAgIHByb2Nlc3NlZERhdGU6IG1vbWVudChjYXJkQ2hhcmdlLmJpbGxpbmdEYXRlLCBEQVRFX0ZPUk1BVCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgICBwZXJpb2Q6IGNhcmRDaGFyZ2UucGVyaW9kLFxuICAgICAgICAgIGJpbGxpbmdUb3RhbDogcGFyc2VGbG9hdChjYXJkQ2hhcmdlLmJpbGxpbmdTdW1TZWtlbCksXG4gICAgICAgIH07XG4gICAgICB9KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIFtdO1xufVxuXG5mdW5jdGlvbiBnZXRUcmFuc2FjdGlvbnNVcmwoc2VydmljZXNVcmw6IHN0cmluZywgbW9udGhNb21lbnQ6IE1vbWVudCkge1xuICBjb25zdCBtb250aCA9IG1vbnRoTW9tZW50Lm1vbnRoKCkgKyAxO1xuICBjb25zdCB5ZWFyID0gbW9udGhNb21lbnQueWVhcigpO1xuICBjb25zdCBtb250aFN0ciA9IG1vbnRoIDwgMTAgPyBgMCR7bW9udGh9YCA6IG1vbnRoLnRvU3RyaW5nKCk7XG4gIGNvbnN0IHVybCA9IG5ldyBVUkwoc2VydmljZXNVcmwpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgncmVxTmFtZScsICdDYXJkc1RyYW5zYWN0aW9uc0xpc3QnKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoJ21vbnRoJywgbW9udGhTdHIpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgneWVhcicsIGAke3llYXJ9YCk7XG4gIHVybC5zZWFyY2hQYXJhbXMuc2V0KCdyZXF1aXJlZERhdGUnLCAnTicpO1xuICByZXR1cm4gdXJsLnRvU3RyaW5nKCk7XG59XG5cbmZ1bmN0aW9uIGNvbnZlcnRDdXJyZW5jeShjdXJyZW5jeVN0cjogc3RyaW5nKSB7XG4gIGlmIChjdXJyZW5jeVN0ciA9PT0gU0hFS0VMX0NVUlJFTkNZX0tFWVdPUkQgfHwgY3VycmVuY3lTdHIgPT09IEFMVF9TSEVLRUxfQ1VSUkVOQ1kpIHtcbiAgICByZXR1cm4gU0hFS0VMX0NVUlJFTkNZO1xuICB9XG4gIHJldHVybiBjdXJyZW5jeVN0cjtcbn1cblxuZnVuY3Rpb24gZ2V0SW5zdGFsbG1lbnRzSW5mbyh0eG46IFNjcmFwZWRUcmFuc2FjdGlvbik6IFRyYW5zYWN0aW9uSW5zdGFsbG1lbnRzIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCF0eG4ubW9yZUluZm8gfHwgIXR4bi5tb3JlSW5mby5pbmNsdWRlcyhJTlNUQUxMTUVOVFNfS0VZV09SRCkpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIGNvbnN0IG1hdGNoZXMgPSB0eG4ubW9yZUluZm8ubWF0Y2goL1xcZCsvZyk7XG4gIGlmICghbWF0Y2hlcyB8fCBtYXRjaGVzLmxlbmd0aCA8IDIpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBudW1iZXI6IHBhcnNlSW50KG1hdGNoZXNbMF0sIDEwKSxcbiAgICB0b3RhbDogcGFyc2VJbnQobWF0Y2hlc1sxXSwgMTApLFxuICB9O1xufVxuXG5mdW5jdGlvbiBnZXRUcmFuc2FjdGlvblR5cGUodHhuOiBTY3JhcGVkVHJhbnNhY3Rpb24pIHtcbiAgcmV0dXJuIGdldEluc3RhbGxtZW50c0luZm8odHhuKSA/IFRyYW5zYWN0aW9uVHlwZXMuSW5zdGFsbG1lbnRzIDogVHJhbnNhY3Rpb25UeXBlcy5Ob3JtYWw7XG59XG5cbmZ1bmN0aW9uIGNvbnZlcnRUcmFuc2FjdGlvbnMoXG4gIHR4bnM6IFNjcmFwZWRUcmFuc2FjdGlvbltdLFxuICBwcm9jZXNzZWREYXRlOiBzdHJpbmcsXG4gIG9wdGlvbnM/OiBTY3JhcGVyT3B0aW9ucyxcbik6IFRyYW5zYWN0aW9uW10ge1xuICBjb25zdCBmaWx0ZXJlZFR4bnMgPSB0eG5zLmZpbHRlcihcbiAgICB0eG4gPT5cbiAgICAgIHR4bi5kZWFsU3VtVHlwZSAhPT0gJzEnICYmIHR4bi52b3VjaGVyTnVtYmVyUmF0eiAhPT0gJzAwMDAwMDAwMCcgJiYgdHhuLnZvdWNoZXJOdW1iZXJSYXR6T3V0Ym91bmQgIT09ICcwMDAwMDAwMDAnLFxuICApO1xuXG4gIHJldHVybiBmaWx0ZXJlZFR4bnMubWFwKHR4biA9PiB7XG4gICAgY29uc3QgaXNPdXRib3VuZCA9IHR4bi5kZWFsU3VtT3V0Ym91bmQ7XG4gICAgY29uc3QgdHhuRGF0ZVN0ciA9IGlzT3V0Ym91bmQgPyB0eG4uZnVsbFB1cmNoYXNlRGF0ZU91dGJvdW5kIDogdHhuLmZ1bGxQdXJjaGFzZURhdGU7XG4gICAgY29uc3QgdHhuTW9tZW50ID0gbW9tZW50KHR4bkRhdGVTdHIsIERBVEVfRk9STUFUKTtcblxuICAgIGNvbnN0IGN1cnJlbnRQcm9jZXNzZWREYXRlID0gdHhuLmZ1bGxQYXltZW50RGF0ZVxuICAgICAgPyBtb21lbnQodHhuLmZ1bGxQYXltZW50RGF0ZSwgREFURV9GT1JNQVQpLnRvSVNPU3RyaW5nKClcbiAgICAgIDogcHJvY2Vzc2VkRGF0ZTtcbiAgICBjb25zdCByZXN1bHQ6IFRyYW5zYWN0aW9uID0ge1xuICAgICAgdHlwZTogZ2V0VHJhbnNhY3Rpb25UeXBlKHR4biksXG4gICAgICBpZGVudGlmaWVyOiBwYXJzZUludChpc091dGJvdW5kID8gdHhuLnZvdWNoZXJOdW1iZXJSYXR6T3V0Ym91bmQgOiB0eG4udm91Y2hlck51bWJlclJhdHosIDEwKSxcbiAgICAgIGRhdGU6IHR4bk1vbWVudC50b0lTT1N0cmluZygpLFxuICAgICAgcHJvY2Vzc2VkRGF0ZTogY3VycmVudFByb2Nlc3NlZERhdGUsXG4gICAgICBiaWxsaW5nRGF0ZTogcHJvY2Vzc2VkRGF0ZSxcbiAgICAgIG9yaWdpbmFsQW1vdW50OiBpc091dGJvdW5kID8gLXR4bi5kZWFsU3VtT3V0Ym91bmQgOiAtdHhuLmRlYWxTdW0sXG4gICAgICBvcmlnaW5hbEN1cnJlbmN5OiBjb252ZXJ0Q3VycmVuY3kodHhuLmN1cnJlbnRQYXltZW50Q3VycmVuY3kgPz8gdHhuLmN1cnJlbmN5SWQpLFxuICAgICAgY2hhcmdlZEFtb3VudDogaXNPdXRib3VuZCA/IC10eG4ucGF5bWVudFN1bU91dGJvdW5kIDogLXR4bi5wYXltZW50U3VtLFxuICAgICAgY2hhcmdlZEN1cnJlbmN5OiBjb252ZXJ0Q3VycmVuY3kodHhuLmN1cnJlbmN5SWQpLFxuICAgICAgZGVzY3JpcHRpb246IGlzT3V0Ym91bmQgPyB0eG4uZnVsbFN1cHBsaWVyTmFtZU91dGJvdW5kIDogdHhuLmZ1bGxTdXBwbGllck5hbWVIZWIsXG4gICAgICBtZW1vOiB0eG4ubW9yZUluZm8gfHwgJycsXG4gICAgICBpbnN0YWxsbWVudHM6IGdldEluc3RhbGxtZW50c0luZm8odHhuKSB8fCB1bmRlZmluZWQsXG4gICAgICBzdGF0dXM6IFRyYW5zYWN0aW9uU3RhdHVzZXMuQ29tcGxldGVkLFxuICAgIH07XG5cbiAgICBpZiAob3B0aW9ucz8uaW5jbHVkZVJhd1RyYW5zYWN0aW9uKSB7XG4gICAgICByZXN1bHQucmF3VHJhbnNhY3Rpb24gPSBnZXRSYXdUcmFuc2FjdGlvbih0eG4pO1xuICAgIH1cblxuICAgIHJldHVybiByZXN1bHQ7XG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBmZXRjaFRyYW5zYWN0aW9ucyhcbiAgcGFnZTogUGFnZSxcbiAgb3B0aW9uczogU2NyYXBlck9wdGlvbnMsXG4gIGNvbXBhbnlTZXJ2aWNlT3B0aW9uczogQ29tcGFueVNlcnZpY2VPcHRpb25zLFxuICBzdGFydE1vbWVudDogTW9tZW50LFxuICBtb250aE1vbWVudDogTW9tZW50LFxuKTogUHJvbWlzZTxTY3JhcGVkQWNjb3VudHNXaXRoSW5kZXg+IHtcbiAgY29uc3QgYWNjb3VudHMgPSBhd2FpdCBmZXRjaEFjY291bnRzKHBhZ2UsIGNvbXBhbnlTZXJ2aWNlT3B0aW9ucy5zZXJ2aWNlc1VybCwgbW9udGhNb21lbnQpO1xuICBjb25zdCBkYXRhVXJsID0gZ2V0VHJhbnNhY3Rpb25zVXJsKGNvbXBhbnlTZXJ2aWNlT3B0aW9ucy5zZXJ2aWNlc1VybCwgbW9udGhNb21lbnQpO1xuICBhd2FpdCBzbGVlcChSQVRFX0xJTUlULlNMRUVQX0JFVFdFRU4pO1xuICBkZWJ1ZyhgZmV0Y2hpbmcgdHJhbnNhY3Rpb25zIGZyb20gJHtkYXRhVXJsfSBmb3IgbW9udGggJHttb250aE1vbWVudC5mb3JtYXQoJ1lZWVktTU0nKX1gKTtcbiAgY29uc3QgZGF0YVJlc3VsdCA9IGF3YWl0IGZldGNoR2V0V2l0aGluUGFnZTxTY3JhcGVkVHJhbnNhY3Rpb25EYXRhPihwYWdlLCBkYXRhVXJsKTtcbiAgaWYgKGRhdGFSZXN1bHQgJiYgZGF0YVJlc3VsdC5IZWFkZXI/LlN0YXR1cyA9PT0gJzEnICYmIGRhdGFSZXN1bHQuQ2FyZHNUcmFuc2FjdGlvbnNMaXN0QmVhbikge1xuICAgIGNvbnN0IGFjY291bnRUeG5zOiBTY3JhcGVkQWNjb3VudHNXaXRoSW5kZXggPSB7fTtcbiAgICBhY2NvdW50cy5mb3JFYWNoKGFjY291bnQgPT4ge1xuICAgICAgY29uc3QgYmlsbGluZ1BlcmlvZDogQmlsbGluZ1BlcmlvZCA9IHtcbiAgICAgICAgYmlsbGluZ0RhdGU6IGFjY291bnQucHJvY2Vzc2VkRGF0ZSxcbiAgICAgICAgc3RhdHVzOiBhY2NvdW50LnBlcmlvZCA9PT0gJ05leHQnID8gJ2N1cnJlbnQnIDogJ3ByZXZpb3VzJyxcbiAgICAgICAgdG90YWw6IGFjY291bnQuYmlsbGluZ1RvdGFsLFxuICAgICAgfTtcblxuICAgICAgY29uc3QgdHhuR3JvdXBzOiBTY3JhcGVkQ3VycmVudENhcmRUcmFuc2FjdGlvbnNbXSB8IHVuZGVmaW5lZCA9XG4gICAgICAgIGRhdGFSZXN1bHQuQ2FyZHNUcmFuc2FjdGlvbnNMaXN0QmVhbj8uW2BJbmRleCR7YWNjb3VudC5pbmRleH1gXT8uQ3VycmVudENhcmRUcmFuc2FjdGlvbnM7XG5cbiAgICAgIGxldCBhbGxUeG5zOiBUcmFuc2FjdGlvbltdID0gW107XG4gICAgICBpZiAodHhuR3JvdXBzKSB7XG4gICAgICAgIHR4bkdyb3Vwcy5mb3JFYWNoKHR4bkdyb3VwID0+IHtcbiAgICAgICAgICBpZiAodHhuR3JvdXAudHhuSXNyYWVsKSB7XG4gICAgICAgICAgICBhbGxUeG5zLnB1c2goLi4uY29udmVydFRyYW5zYWN0aW9ucyh0eG5Hcm91cC50eG5Jc3JhZWwsIGFjY291bnQucHJvY2Vzc2VkRGF0ZSwgb3B0aW9ucykpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAodHhuR3JvdXAudHhuQWJyb2FkKSB7XG4gICAgICAgICAgICBhbGxUeG5zLnB1c2goLi4uY29udmVydFRyYW5zYWN0aW9ucyh0eG5Hcm91cC50eG5BYnJvYWQsIGFjY291bnQucHJvY2Vzc2VkRGF0ZSwgb3B0aW9ucykpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgaWYgKCFvcHRpb25zLmNvbWJpbmVJbnN0YWxsbWVudHMpIHtcbiAgICAgICAgICBhbGxUeG5zID0gZml4SW5zdGFsbG1lbnRzKGFsbFR4bnMpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChvcHRpb25zLm91dHB1dERhdGE/LmVuYWJsZVRyYW5zYWN0aW9uc0ZpbHRlckJ5RGF0ZSA/PyB0cnVlKSB7XG4gICAgICAgICAgYWxsVHhucyA9IGZpbHRlck9sZFRyYW5zYWN0aW9ucyhhbGxUeG5zLCBzdGFydE1vbWVudCwgb3B0aW9ucy5jb21iaW5lSW5zdGFsbG1lbnRzIHx8IGZhbHNlKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAoYWNjb3VudFR4bnNbYWNjb3VudC5hY2NvdW50TnVtYmVyXSkge1xuICAgICAgICBhY2NvdW50VHhuc1thY2NvdW50LmFjY291bnROdW1iZXJdLnR4bnMucHVzaCguLi5hbGxUeG5zKTtcbiAgICAgICAgYWNjb3VudFR4bnNbYWNjb3VudC5hY2NvdW50TnVtYmVyXS5iaWxsaW5nUGVyaW9kcyEucHVzaChiaWxsaW5nUGVyaW9kKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGFjY291bnRUeG5zW2FjY291bnQuYWNjb3VudE51bWJlcl0gPSB7XG4gICAgICAgICAgYWNjb3VudE51bWJlcjogYWNjb3VudC5hY2NvdW50TnVtYmVyLFxuICAgICAgICAgIGluZGV4OiBhY2NvdW50LmluZGV4LFxuICAgICAgICAgIHR4bnM6IGFsbFR4bnMsXG4gICAgICAgICAgYmlsbGluZ1BlcmlvZHM6IFtiaWxsaW5nUGVyaW9kXSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICByZXR1cm4gYWNjb3VudFR4bnM7XG4gIH1cblxuICByZXR1cm4ge307XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldEV4dHJhU2NyYXBUcmFuc2FjdGlvbihcbiAgcGFnZTogUGFnZSxcbiAgb3B0aW9uczogQ29tcGFueVNlcnZpY2VPcHRpb25zLFxuICBtb250aDogTW9tZW50LFxuICBhY2NvdW50SW5kZXg6IG51bWJlcixcbiAgdHJhbnNhY3Rpb246IFRyYW5zYWN0aW9uLFxuKTogUHJvbWlzZTxUcmFuc2FjdGlvbj4ge1xuICBjb25zdCB1cmwgPSBuZXcgVVJMKG9wdGlvbnMuc2VydmljZXNVcmwpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgncmVxTmFtZScsICdQaXJ0ZXlJc2thXzIwNCcpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgnQ2FyZEluZGV4JywgYWNjb3VudEluZGV4LnRvU3RyaW5nKCkpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgnc2hvdmFyUmF0eicsIHRyYW5zYWN0aW9uLmlkZW50aWZpZXIhLnRvU3RyaW5nKCkpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldCgnbW9lZENoaXV2JywgbW9udGguZm9ybWF0KCdNTVlZWVknKSk7XG5cbiAgZGVidWcoYGZldGNoaW5nIGV4dHJhIHNjcmFwIGZvciB0cmFuc2FjdGlvbiAke3RyYW5zYWN0aW9uLmlkZW50aWZpZXJ9IGZvciBtb250aCAke21vbnRoLmZvcm1hdCgnWVlZWS1NTScpfWApO1xuICBjb25zdCBkYXRhID0gYXdhaXQgZmV0Y2hHZXRXaXRoaW5QYWdlPFNjcmFwZWRUcmFuc2FjdGlvbkRhdGE+KHBhZ2UsIHVybC50b1N0cmluZygpKTtcbiAgaWYgKCFkYXRhKSB7XG4gICAgcmV0dXJuIHRyYW5zYWN0aW9uO1xuICB9XG5cbiAgY29uc3QgcmF3Q2F0ZWdvcnkgPSBkYXRhLlBpcnRleUlza2FfMjA0QmVhbj8uc2VjdG9yID8/ICcnO1xuICByZXR1cm4ge1xuICAgIC4uLnRyYW5zYWN0aW9uLFxuICAgIGNhdGVnb3J5OiByYXdDYXRlZ29yeS50cmltKCksXG4gICAgcmF3VHJhbnNhY3Rpb246IGdldFJhd1RyYW5zYWN0aW9uKGRhdGEsIHRyYW5zYWN0aW9uKSxcbiAgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0RXh0cmFTY3JhcEFjY291bnQoXG4gIHBhZ2U6IFBhZ2UsXG4gIG9wdGlvbnM6IENvbXBhbnlTZXJ2aWNlT3B0aW9ucyxcbiAgYWNjb3VudE1hcDogU2NyYXBlZEFjY291bnRzV2l0aEluZGV4LFxuICBtb250aDogbW9tZW50Lk1vbWVudCxcbik6IFByb21pc2U8U2NyYXBlZEFjY291bnRzV2l0aEluZGV4PiB7XG4gIGNvbnN0IGFjY291bnRzOiBTY3JhcGVkQWNjb3VudHNXaXRoSW5kZXhbc3RyaW5nXVtdID0gW107XG4gIGZvciAoY29uc3QgYWNjb3VudCBvZiBPYmplY3QudmFsdWVzKGFjY291bnRNYXApKSB7XG4gICAgZGVidWcoXG4gICAgICBgZ2V0IGV4dHJhIHNjcmFwIGZvciAke2FjY291bnQuYWNjb3VudE51bWJlcn0gd2l0aCAke2FjY291bnQudHhucy5sZW5ndGh9IHRyYW5zYWN0aW9uc2AsXG4gICAgICBtb250aC5mb3JtYXQoJ1lZWVktTU0nKSxcbiAgICApO1xuICAgIGNvbnN0IHR4bnM6IFRyYW5zYWN0aW9uW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IHR4bnNDaHVuayBvZiBjaHVuayhhY2NvdW50LnR4bnMsIFJBVEVfTElNSVQuVFJBTlNBQ1RJT05TX0JBVENIX1NJWkUpKSB7XG4gICAgICBkZWJ1ZyhgcHJvY2Vzc2luZyBjaHVuayBvZiAke3R4bnNDaHVuay5sZW5ndGh9IHRyYW5zYWN0aW9ucyBmb3IgYWNjb3VudCAke2FjY291bnQuYWNjb3VudE51bWJlcn1gKTtcbiAgICAgIGNvbnN0IHVwZGF0ZWRUeG5zID0gYXdhaXQgUHJvbWlzZS5hbGwoXG4gICAgICAgIHR4bnNDaHVuay5tYXAodCA9PiBnZXRFeHRyYVNjcmFwVHJhbnNhY3Rpb24ocGFnZSwgb3B0aW9ucywgbW9udGgsIGFjY291bnQuaW5kZXgsIHQpKSxcbiAgICAgICk7XG4gICAgICBhd2FpdCBzbGVlcChSQVRFX0xJTUlULlNMRUVQX0JFVFdFRU4pO1xuICAgICAgdHhucy5wdXNoKC4uLnVwZGF0ZWRUeG5zKTtcbiAgICB9XG4gICAgYWNjb3VudHMucHVzaCh7IC4uLmFjY291bnQsIHR4bnMgfSk7XG4gIH1cblxuICByZXR1cm4gYWNjb3VudHMucmVkdWNlKChtLCB4KSA9PiAoeyAuLi5tLCBbeC5hY2NvdW50TnVtYmVyXTogeCB9KSwge30pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRBZGRpdGlvbmFsVHJhbnNhY3Rpb25JbmZvcm1hdGlvbihcbiAgc2NyYXBlck9wdGlvbnM6IFNjcmFwZXJPcHRpb25zLFxuICBhY2NvdW50c1dpdGhJbmRleDogU2NyYXBlZEFjY291bnRzV2l0aEluZGV4W10sXG4gIHBhZ2U6IFBhZ2UsXG4gIG9wdGlvbnM6IENvbXBhbnlTZXJ2aWNlT3B0aW9ucyxcbiAgYWxsTW9udGhzOiBtb21lbnQuTW9tZW50W10sXG4pOiBQcm9taXNlPFNjcmFwZWRBY2NvdW50c1dpdGhJbmRleFtdPiB7XG4gIGlmIChcbiAgICAhc2NyYXBlck9wdGlvbnMuYWRkaXRpb25hbFRyYW5zYWN0aW9uSW5mb3JtYXRpb24gfHxcbiAgICBzY3JhcGVyT3B0aW9ucy5vcHRJbkZlYXR1cmVzPy5pbmNsdWRlcygnaXNyYWNhcmQtYW1leDpza2lwQWRkaXRpb25hbFRyYW5zYWN0aW9uSW5mb3JtYXRpb24nKVxuICApIHtcbiAgICByZXR1cm4gYWNjb3VudHNXaXRoSW5kZXg7XG4gIH1cbiAgcmV0dXJuIHJ1blNlcmlhbChhY2NvdW50c1dpdGhJbmRleC5tYXAoKGEsIGkpID0+ICgpID0+IGdldEV4dHJhU2NyYXBBY2NvdW50KHBhZ2UsIG9wdGlvbnMsIGEsIGFsbE1vbnRoc1tpXSkpKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZmV0Y2hBbGxUcmFuc2FjdGlvbnMoXG4gIHBhZ2U6IFBhZ2UsXG4gIG9wdGlvbnM6IFNjcmFwZXJPcHRpb25zLFxuICBjb21wYW55U2VydmljZU9wdGlvbnM6IENvbXBhbnlTZXJ2aWNlT3B0aW9ucyxcbiAgc3RhcnRNb21lbnQ6IE1vbWVudCxcbikge1xuICBjb25zdCBmdXR1cmVNb250aHNUb1NjcmFwZSA9IG9wdGlvbnMuZnV0dXJlTW9udGhzVG9TY3JhcGUgPz8gMTtcbiAgY29uc3QgYWxsTW9udGhzID0gZ2V0QWxsTW9udGhNb21lbnRzKHN0YXJ0TW9tZW50LCBmdXR1cmVNb250aHNUb1NjcmFwZSk7XG4gIGNvbnN0IHJlc3VsdHM6IFNjcmFwZWRBY2NvdW50c1dpdGhJbmRleFtdID0gYXdhaXQgcnVuU2VyaWFsKFxuICAgIGFsbE1vbnRocy5tYXAobW9udGhNb21lbnQgPT4gKCkgPT4ge1xuICAgICAgcmV0dXJuIGZldGNoVHJhbnNhY3Rpb25zKHBhZ2UsIG9wdGlvbnMsIGNvbXBhbnlTZXJ2aWNlT3B0aW9ucywgc3RhcnRNb21lbnQsIG1vbnRoTW9tZW50KTtcbiAgICB9KSxcbiAgKTtcblxuICBkZWJ1Zyh7IHBhZ2UgfSk7XG5cbiAgY29uc3QgZmluYWxSZXN1bHQgPSBhd2FpdCBnZXRBZGRpdGlvbmFsVHJhbnNhY3Rpb25JbmZvcm1hdGlvbihcbiAgICBvcHRpb25zLFxuICAgIHJlc3VsdHMsXG4gICAgcGFnZSxcbiAgICBjb21wYW55U2VydmljZU9wdGlvbnMsXG4gICAgYWxsTW9udGhzLFxuICApO1xuICBjb25zdCBjb21iaW5lZFR4bnM6IFJlY29yZDxzdHJpbmcsIFRyYW5zYWN0aW9uW10+ID0ge307XG4gIGNvbnN0IGNvbWJpbmVkQmlsbGluZ1BlcmlvZHM6IFJlY29yZDxzdHJpbmcsIEJpbGxpbmdQZXJpb2RbXT4gPSB7fTtcblxuICBmaW5hbFJlc3VsdC5mb3JFYWNoKHJlc3VsdCA9PiB7XG4gICAgT2JqZWN0LmtleXMocmVzdWx0KS5mb3JFYWNoKGFjY291bnROdW1iZXIgPT4ge1xuICAgICAgaWYgKCFjb21iaW5lZFR4bnNbYWNjb3VudE51bWJlcl0pIHtcbiAgICAgICAgY29tYmluZWRUeG5zW2FjY291bnROdW1iZXJdID0gW107XG4gICAgICB9XG4gICAgICBjb21iaW5lZFR4bnNbYWNjb3VudE51bWJlcl0ucHVzaCguLi5yZXN1bHRbYWNjb3VudE51bWJlcl0udHhucyk7XG5cbiAgICAgIGlmICghY29tYmluZWRCaWxsaW5nUGVyaW9kc1thY2NvdW50TnVtYmVyXSkge1xuICAgICAgICBjb21iaW5lZEJpbGxpbmdQZXJpb2RzW2FjY291bnROdW1iZXJdID0gW107XG4gICAgICB9XG4gICAgICBjb21iaW5lZEJpbGxpbmdQZXJpb2RzW2FjY291bnROdW1iZXJdLnB1c2goLi4uKHJlc3VsdFthY2NvdW50TnVtYmVyXS5iaWxsaW5nUGVyaW9kcyA/PyBbXSkpO1xuICAgIH0pO1xuICB9KTtcblxuICBjb25zdCBhbGxBY2NvdW50TnVtYmVycyA9IG5ldyBTZXQoWy4uLk9iamVjdC5rZXlzKGNvbWJpbmVkVHhucyksIC4uLk9iamVjdC5rZXlzKGNvbWJpbmVkQmlsbGluZ1BlcmlvZHMpXSk7XG5cbiAgY29uc3QgYWNjb3VudHMgPSBBcnJheS5mcm9tKGFsbEFjY291bnROdW1iZXJzKS5tYXAoYWNjb3VudE51bWJlciA9PiB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGFjY291bnROdW1iZXIsXG4gICAgICB0eG5zOiBjb21iaW5lZFR4bnNbYWNjb3VudE51bWJlcl0gPz8gW10sXG4gICAgICBiaWxsaW5nUGVyaW9kczogY29tYmluZWRCaWxsaW5nUGVyaW9kc1thY2NvdW50TnVtYmVyXSxcbiAgICB9O1xuICB9KTtcblxuICByZXR1cm4ge1xuICAgIHN1Y2Nlc3M6IHRydWUsXG4gICAgYWNjb3VudHMsXG4gIH07XG59XG5cbnR5cGUgU2NyYXBlclNwZWNpZmljQ3JlZGVudGlhbHMgPSB7IGlkOiBzdHJpbmc7IHBhc3N3b3JkOiBzdHJpbmc7IGNhcmQ2RGlnaXRzOiBzdHJpbmcgfTtcbmNsYXNzIElzcmFjYXJkQW1leEJhc2VTY3JhcGVyIGV4dGVuZHMgQmFzZVNjcmFwZXJXaXRoQnJvd3NlcjxTY3JhcGVyU3BlY2lmaWNDcmVkZW50aWFscz4ge1xuICBwcml2YXRlIGJhc2VVcmw6IHN0cmluZztcblxuICBwcml2YXRlIGNvbXBhbnlDb2RlOiBzdHJpbmc7XG5cbiAgcHJpdmF0ZSBzZXJ2aWNlc1VybDogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKG9wdGlvbnM6IFNjcmFwZXJPcHRpb25zLCBiYXNlVXJsOiBzdHJpbmcsIGNvbXBhbnlDb2RlOiBzdHJpbmcpIHtcbiAgICBzdXBlcihvcHRpb25zKTtcblxuICAgIHRoaXMuYmFzZVVybCA9IGJhc2VVcmw7XG4gICAgdGhpcy5jb21wYW55Q29kZSA9IGNvbXBhbnlDb2RlO1xuICAgIHRoaXMuc2VydmljZXNVcmwgPSBgJHtiYXNlVXJsfS9zZXJ2aWNlcy9Qcm94eVJlcXVlc3RIYW5kbGVyLmFzaHhgO1xuICB9XG5cbiAgYXN5bmMgbG9naW4oY3JlZGVudGlhbHM6IFNjcmFwZXJTcGVjaWZpY0NyZWRlbnRpYWxzKTogUHJvbWlzZTxTY3JhcGVyU2NyYXBpbmdSZXN1bHQ+IHtcbiAgICBhd2FpdCB0aGlzLnBhZ2Uuc2V0UmVxdWVzdEludGVyY2VwdGlvbih0cnVlKTtcbiAgICB0aGlzLnBhZ2Uub24oJ3JlcXVlc3QnLCByZXF1ZXN0ID0+IHtcbiAgICAgIGlmIChyZXF1ZXN0LnVybCgpLmluY2x1ZGVzKCdkZXRlY3Rvci1kb20ubWluLmpzJykpIHtcbiAgICAgICAgZGVidWcoJ2ZvcmNlIGFib3J0IGZvciByZXF1ZXN0IGRvIGRvd25sb2FkIGRldGVjdG9yLWRvbS5taW4uanMgcmVzb3VyY2UnKTtcbiAgICAgICAgdm9pZCByZXF1ZXN0LmFib3J0KHVuZGVmaW5lZCwgaW50ZXJjZXB0aW9uUHJpb3JpdGllcy5hYm9ydCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB2b2lkIHJlcXVlc3QuY29udGludWUodW5kZWZpbmVkLCBpbnRlcmNlcHRpb25Qcmlvcml0aWVzLmNvbnRpbnVlKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGF3YWl0IG1hc2tIZWFkbGVzc1VzZXJBZ2VudCh0aGlzLnBhZ2UpO1xuXG4gICAgYXdhaXQgdGhpcy5uYXZpZ2F0ZVRvKGAke3RoaXMuYmFzZVVybH0vcGVyc29uYWxhcmVhL0xvZ2luYCk7XG5cbiAgICB0aGlzLmVtaXRQcm9ncmVzcyhTY3JhcGVyUHJvZ3Jlc3NUeXBlcy5Mb2dnaW5nSW4pO1xuXG4gICAgY29uc3QgdmFsaWRhdGVVcmwgPSBgJHt0aGlzLnNlcnZpY2VzVXJsfT9yZXFOYW1lPVZhbGlkYXRlSWREYXRhYDtcbiAgICBjb25zdCB2YWxpZGF0ZVJlcXVlc3QgPSB7XG4gICAgICBpZDogY3JlZGVudGlhbHMuaWQsXG4gICAgICBjYXJkU3VmZml4OiBjcmVkZW50aWFscy5jYXJkNkRpZ2l0cyxcbiAgICAgIGNvdW50cnlDb2RlOiBDT1VOVFJZX0NPREUsXG4gICAgICBpZFR5cGU6IElEX1RZUEUsXG4gICAgICBjaGVja0xldmVsOiAnMScsXG4gICAgICBjb21wYW55Q29kZTogdGhpcy5jb21wYW55Q29kZSxcbiAgICB9O1xuICAgIGRlYnVnKCdsb2dnaW5nIGluIHdpdGggdmFsaWRhdGUgcmVxdWVzdCcpO1xuICAgIGNvbnN0IHZhbGlkYXRlUmVzdWx0ID0gYXdhaXQgZmV0Y2hQb3N0V2l0aGluUGFnZTxTY3JhcGVkTG9naW5WYWxpZGF0aW9uPih0aGlzLnBhZ2UsIHZhbGlkYXRlVXJsLCB2YWxpZGF0ZVJlcXVlc3QpO1xuICAgIGlmIChcbiAgICAgICF2YWxpZGF0ZVJlc3VsdCB8fFxuICAgICAgIXZhbGlkYXRlUmVzdWx0LkhlYWRlciB8fFxuICAgICAgdmFsaWRhdGVSZXN1bHQuSGVhZGVyLlN0YXR1cyAhPT0gJzEnIHx8XG4gICAgICAhdmFsaWRhdGVSZXN1bHQuVmFsaWRhdGVJZERhdGFCZWFuXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ3Vua25vd24gZXJyb3IgZHVyaW5nIGxvZ2luJyk7XG4gICAgfVxuXG4gICAgY29uc3QgdmFsaWRhdGVSZXR1cm5Db2RlID0gdmFsaWRhdGVSZXN1bHQuVmFsaWRhdGVJZERhdGFCZWFuLnJldHVybkNvZGU7XG4gICAgZGVidWcoYHVzZXIgdmFsaWRhdGUgd2l0aCByZXR1cm4gY29kZSAnJHt2YWxpZGF0ZVJldHVybkNvZGV9J2ApO1xuICAgIGlmICh2YWxpZGF0ZVJldHVybkNvZGUgPT09ICcxJykge1xuICAgICAgY29uc3QgeyB1c2VyTmFtZSB9ID0gdmFsaWRhdGVSZXN1bHQuVmFsaWRhdGVJZERhdGFCZWFuO1xuXG4gICAgICBjb25zdCBsb2dpblVybCA9IGAke3RoaXMuc2VydmljZXNVcmx9P3JlcU5hbWU9cGVyZm9ybUxvZ29uSWA7XG4gICAgICBjb25zdCByZXF1ZXN0ID0ge1xuICAgICAgICBLb2RNaXNodGFtZXNoOiB1c2VyTmFtZSxcbiAgICAgICAgTWlzcGFyWmlodXk6IGNyZWRlbnRpYWxzLmlkLFxuICAgICAgICBTaXNtYTogY3JlZGVudGlhbHMucGFzc3dvcmQsXG4gICAgICAgIGNhcmRTdWZmaXg6IGNyZWRlbnRpYWxzLmNhcmQ2RGlnaXRzLFxuICAgICAgICBjb3VudHJ5Q29kZTogQ09VTlRSWV9DT0RFLFxuICAgICAgICBpZFR5cGU6IElEX1RZUEUsXG4gICAgICB9O1xuICAgICAgZGVidWcoJ3VzZXIgbG9naW4gc3RhcnRlZCcpO1xuICAgICAgY29uc3QgbG9naW5SZXN1bHQgPSBhd2FpdCBmZXRjaFBvc3RXaXRoaW5QYWdlPHsgc3RhdHVzOiBzdHJpbmcgfT4odGhpcy5wYWdlLCBsb2dpblVybCwgcmVxdWVzdCk7XG4gICAgICBkZWJ1ZyhgdXNlciBsb2dpbiB3aXRoIHN0YXR1cyAnJHtsb2dpblJlc3VsdD8uc3RhdHVzfSdgLCBsb2dpblJlc3VsdCk7XG5cbiAgICAgIGlmIChsb2dpblJlc3VsdCAmJiBsb2dpblJlc3VsdC5zdGF0dXMgPT09ICcxJykge1xuICAgICAgICB0aGlzLmVtaXRQcm9ncmVzcyhTY3JhcGVyUHJvZ3Jlc3NUeXBlcy5Mb2dpblN1Y2Nlc3MpO1xuICAgICAgICByZXR1cm4geyBzdWNjZXNzOiB0cnVlIH07XG4gICAgICB9XG5cbiAgICAgIGlmIChsb2dpblJlc3VsdCAmJiBsb2dpblJlc3VsdC5zdGF0dXMgPT09ICczJykge1xuICAgICAgICB0aGlzLmVtaXRQcm9ncmVzcyhTY3JhcGVyUHJvZ3Jlc3NUeXBlcy5DaGFuZ2VQYXNzd29yZCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgICAgZXJyb3JUeXBlOiBTY3JhcGVyRXJyb3JUeXBlcy5DaGFuZ2VQYXNzd29yZCxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgdGhpcy5lbWl0UHJvZ3Jlc3MoU2NyYXBlclByb2dyZXNzVHlwZXMuTG9naW5GYWlsZWQpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgIGVycm9yVHlwZTogU2NyYXBlckVycm9yVHlwZXMuSW52YWxpZFBhc3N3b3JkLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBpZiAodmFsaWRhdGVSZXR1cm5Db2RlID09PSAnNCcpIHtcbiAgICAgIHRoaXMuZW1pdFByb2dyZXNzKFNjcmFwZXJQcm9ncmVzc1R5cGVzLkNoYW5nZVBhc3N3b3JkKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgICBlcnJvclR5cGU6IFNjcmFwZXJFcnJvclR5cGVzLkNoYW5nZVBhc3N3b3JkLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICB0aGlzLmVtaXRQcm9ncmVzcyhTY3JhcGVyUHJvZ3Jlc3NUeXBlcy5Mb2dpbkZhaWxlZCk7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgZXJyb3JUeXBlOiBTY3JhcGVyRXJyb3JUeXBlcy5JbnZhbGlkUGFzc3dvcmQsXG4gICAgfTtcbiAgfVxuXG4gIGFzeW5jIGZldGNoRGF0YSgpIHtcbiAgICBjb25zdCBkZWZhdWx0U3RhcnRNb21lbnQgPSBtb21lbnQoKS5zdWJ0cmFjdCgxLCAneWVhcnMnKTtcbiAgICBjb25zdCBzdGFydERhdGUgPSB0aGlzLm9wdGlvbnMuc3RhcnREYXRlIHx8IGRlZmF1bHRTdGFydE1vbWVudC50b0RhdGUoKTtcbiAgICBjb25zdCBzdGFydE1vbWVudCA9IG1vbWVudC5tYXgoZGVmYXVsdFN0YXJ0TW9tZW50LCBtb21lbnQoc3RhcnREYXRlKSk7XG5cbiAgICByZXR1cm4gZmV0Y2hBbGxUcmFuc2FjdGlvbnMoXG4gICAgICB0aGlzLnBhZ2UsXG4gICAgICB0aGlzLm9wdGlvbnMsXG4gICAgICB7XG4gICAgICAgIHNlcnZpY2VzVXJsOiB0aGlzLnNlcnZpY2VzVXJsLFxuICAgICAgICBjb21wYW55Q29kZTogdGhpcy5jb21wYW55Q29kZSxcbiAgICAgIH0sXG4gICAgICBzdGFydE1vbWVudCxcbiAgICApO1xuICB9XG59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