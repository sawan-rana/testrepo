'use strict';

var util = require('util');
var uuidv1 = require('uuid/v1');
var debug = require('debug')('routes:order:prevalidate');
var config = require('../../config');
var utils = require('../../lib').utils;
var engine = require('../../lib/engine');
var overrideApi = require('../../api').override;
var async = require('async');
var obcache = require('obcache');
var redisApi = require('../../lib/redis_cache.js');
var redis = require('../../lib/redis.js');
var listingApi = require('../../api/listing');
var entProviderMappers = require('../../api/ent_provider_mappers');
var entProviders = require('../../api/ent_providers');
var entCategoryMappers = require('../../api/ent_category_mappers');
var entCategories = require('../../api/ent_categories');
var mailNotifier = require('../../resources/scripts/PrevalidateBookingFailure');
var eventsApi = require('../../api/events/events');
var parksApi = require('../../api/themeparks/parks');
var parkPackageApi = require('../../api/themeparks/park_packages');
var addOns = require('../../routes/add_ons');
var ffApi = require('../../api').fulfillment;
var sac_events = config.sac_events;
var sac_parks = config.sac_parks;
var eventhigh = require('../../resources/seeds/eventsHigh/eventsHigh');
var eventnow = require('../../resources/seeds/eventsNow/eventsNow');
var get2game = require('../../resources/seeds/get2games/get2games');
var insiderApi = require('../../resources/seeds/insider/insider');
var insuranceApi = require('../../api/insurance');
var priceAPI = {
  'themeparks': require('../../api/themeparks').park_package_price,
  'events': require('../../api/events').prices
};
var unidecode = require('unidecode');
var fetchForm = require('../order/create');
var orderLimit = config.orderLimit;
var errorMessage;
var orderLimitEntity = config.orderLimitEntity;
var moment = require('moment');
var eventType;
var event_type_id;
var provider_id;
var seatData;
var db_inventory;
var offline;

var HttpStatus = require('http-status-codes');

var mapWarehouse = {
  638406: 338221,
  569751: 319986,
  635657: 337782,
  498181: 289204,
  646425: 339442,
  631066: 344202,
  626507: 344204,
  643291: 345417
};
var tedXEvents = [173569];
var comicConEvents = [173515];

var map = {
  'CH3 Toddler': 'Toddler',
  'DP Toddler': 'Toddler',
  'Toddler.': 'Toddler',
  'Kid.': 'Kid',
  'DP Kid': 'Kid',
  'CH3 Kid': 'Kid',
  'Last3 Kid': 'Kid',
  'Adult.': 'Adult',
  'DP Adult': 'Adult',
  'CH3 Adult': 'Adult',
  'Last3 Adult': 'Adult',
  'Senior.': 'Senior Citizen',
  'DP Senior': 'Senior Citizen',
  'CH3 Senior': 'Senior Citizen',
  'Last3 Senior': 'Senior Citizen',
  'Sr Citizen.': 'Senior Citizen',
  'HH3 Senior': 'Senior Citizen',
  'HH3 Kid': 'Kid',
  'HH3 Adult': 'Adult',
  'HH3 Toddler': 'Toddler',
  '5hrs Senior': 'Senior Citizen',
  '5hrs Kid': 'Kid',
  '5hrs Adult': 'Adult',
  '5hrs Toddler': 'Toddler',
  'Sr. Citizen': 'Senior Citizen',
  'CH4 Senior': 'Senior Citizen',
  'CH4 Kid': 'Kid',
  'CH4 Adult': 'Adult',
  'CH4 Toddler': 'Toddler',
  'Last3 Toddler': 'Toddler'
};

var DMID = [252863]; //To disable TCS for these DMIDs
var GSTINNotRequiredArr=[252863]; //For these merchant ids GSTIN not required
var defalut_cut_off = Number(config.defalut_cut_off_time);


function getEventId(eventId, cb) {
  var options = { id: eventId };
  eventsApi.select(options, function (err, res) {
    if (err || !res || !res.length)
      return cb(err || new Error("some error occured"));
    return cb(null, res[0].provider_event_id);
  });
}

function checkInventory(priceObject, overrideDetails, seat, cb) {
  seatData = seat;
  var options;
  var update_key=(eventType === "events")?"event_prices." + seat.seatId + ".inventory":"park_package_price." + seat.seatId + ".ticket_inventory";
  options = {
    update_key: update_key
  };
  var searchKey;
  if (!overrideDetails[update_key]) {
    searchKey = (seat.providerSeatId && seat.providerSeatId !== undefined && seat.providerSeatId !== null && seat.providerSeatId != 97700 && Number(offline) !== 1)
                 ? seat.providerSeatId : seat.seatId;

    if (!priceObject[searchKey]) {
      return cb();
    } else {
      if (Number(priceObject[searchKey].inventory) < Number(seat.count)) {
        util.log("seat count is " + seat.count);
        util.log("Inventory count is" + priceObject[searchKey].inventory);
        db_inventory = priceObject[searchKey].inventory;
        return cb(new Error("Inventory out of stock"), priceObject[searchKey].inventory);
      }
      else
        return cb();
    }
  }
  else {
    if (Number(overrideDetails[update_key].value) < Number(seat.count)) {
      util.log("Seat count is: " + seat.count);
      util.log("Inventory count is: " + overrideDetails[update_key].value);
      db_inventory = overrideDetails[update_key].value;
      return cb(new Error("Inventory out of stock."), overrideDetails[update_key].value);
    }
    else
      return cb();
  }
}

function nameCheck(metadata, reqdata, cb) {
  var event_id = metadata.entityId;
  var options =
    {
      id: event_id
    };
  var update_key=(eventType === "events") ? ("events." + event_id + ".name") : ("parks." + event_id + ".name");

  if (!reqdata.overrideDetails[update_key]) {
    if (unidecode(metadata.entityName) != unidecode(reqdata.eventOrpark_details.name)) {
      util.log("Entity Name is: " + unidecode(metadata.entityName));
      util.log("Name from db is: " + unidecode(reqdata.eventOrpark_details.name));
      return cb(new Error("Someone is trying to hack !"));
    }
    else
      return cb();
  }
  else {
    if (unidecode(reqdata.overrideDetails[update_key].value) != unidecode(metadata.entityName)) {
      util.log("Entity Name is: " + unidecode(metadata.entityName));
      util.log("Name from db is: " + unidecode(reqdata.overrideDetails[update_key].value));
      return cb(new Error("Someone is trying to hack !"));
    }
    else
      return cb();
  }
}

function checkData(reqdata, seat, cb) {
  var options, searchKey;
  util.log("seat data is " + JSON.stringify(seat));
  searchKey = seat.providerSeatId ? seat.providerSeatId : seat.seatId;
  var eventId;
  var seatLabel;
  if (!seat.seatType)
    return cb();
  var update_key = (eventType === "events")?"event_prices." + seat.seatId + ".seat_type" : "park_package_price." + seat.seatId + ".ticket_category";
  if (!reqdata.overrideDetails[update_key]) {

    if (!reqdata.price_details[searchKey]) {
      return cb();
    } else {
      if (eventType === "events") {
        seatLabel = (Number(provider_id) == 84 || Number(provider_id) === 157) ? (map[reqdata.price_details[searchKey].label_type] || reqdata.price_details[searchKey].label_type) : reqdata.price_details[searchKey].label_type;
        eventId = reqdata.price_details[searchKey].event_id;
      }
      else {
        seatLabel = (Number(provider_id) == 84 || Number(provider_id) === 157) ? (map[reqdata.price_details[searchKey].seat_type] || reqdata.price_details[searchKey].seat_type) : reqdata.price_details[searchKey].seat_type;
        eventId = reqdata.price_details[searchKey].park_id;
      }
      if (seat.seatType != seatLabel) {
        util.log("Seat type is: " + seat.seatType);
        util.log("Seat type from db is: " + seatLabel);
        return cb(new Error("Someone is trying to hack !"));
      } else {
        if ((eventType === "themeparks") && seat.packageType) {
          options = {
            id: reqdata.price_details[searchKey].park_package_id,
            package_type: seat.packageType
          };
          var update_key = "park_packages." + reqdata.price_details[searchKey].park_package_id + ".package_type";
          if (!reqdata.overrideDetails[update_key]) {
            parkPackageApi.select(options, function (err, res) {
              if (err || !res)
                return cb(err || new Error("Some error occured in package table"));
              else if (!res.length)
                return cb();
              else {
                if (res[0].package_type != seat.packageType) {
                  util.log("Package type is: " + seat.packageType);
                  util.log("Package type from db is: " + res[0].package_type);
                  return cb(new Error("Someone is trying to hack !"));
                }
                else
                  return cb();
              }
            });
          }
          else {
            if (reqdata.overrideDetails[update_key].value != seat.packageType) {
              util.log("Package type is: " + seat.packageType);
              util.log("Package type from db is" + reqdata.overrideDetails[update_key].value);
              return cb(new Error("Someone is trying to hack !"));
            }
            else
              return cb();
          }
        }
        else
          return cb();
      }
    }
  }
  else {
    reqdata.overrideDetails[update_key].value = ((Number(provider_id) === 84 || Number(provider_id) === 157)) ?  (map[reqdata.overrideDetails[update_key].value] || reqdata.overrideDetails[update_key].value) : reqdata.overrideDetails[update_key].value;
    if (reqdata.overrideDetails[update_key].value != seat.seatType) {
      util.log("Seat type is: " + seat.seatType);
      util.log("Seat type from override is: " + reqdata.overrideDetails[update_key].value);
      return cb(new Error("Someone is trying to hack !"));
    }
    else {
      searchKey = seat.providerSeatId ? seat.providerSeatId : seat.seatId;
      if (eventType === "themeparks" && seat.packageType) {
        if (!reqdata.price_details[searchKey]) {
          return cb();
        } else {
          var update_key = "park_packages." + reqdata.price_details[searchKey].park_package_id + ".package_type";
          if (!reqdata.overrideDetails[update_key]) {
            options = {
              id: reqdata.price_details[searchKey].park_package_id,
              package_type: seat.packageType
            };
            parkPackageApi.select(options, function (err, res) {
              if (err || !res)
                return cb(err || new Error("Some error occured in package table"));
              else if (!res.length)
                return cb();
              else {
                if (res[0].package_type != seat.packageType) {
                  util.log("Package type is: " + seat.packageType);
                  util.log("Package type from db is: " + res[0].package_type);
                  return cb(new Error("Someone is trying to hack !"));
                }
                else
                  return cb();
              }
            });
          }
          else {
            if (reqdata.overrideDetails[update_key].value != seat.packageType) {
              util.log("Package type is: " + seat.packageType);
              util.log("Package type from db is: " + reqdata.overrideDetails[update_key].value);
              return cb(new Error("Someone is trying to hack !"));
            }
            else
              return cb();
          }
        }
      }
      else
        return cb();
    }
  }
}

function calOriginal(options, overrideDetails, cb) {
  var update_key = (options.type === "events") ? ("events." + options.entId + ".conv_fee") : ("parks." + options.entId + ".convFee");
  if (!overrideDetails[update_key])
    return cb(null, options);
  else {
    options.fee.convFee = overrideDetails[update_key].value;
    return cb(null, options);
  }
}

function get_price(meta_data, reqdata, cb) {
  var type = meta_data.entityType;
  var seatInfo = meta_data.seatInfo;
  var price = 0;
  var key;
  var options;
  async.eachSeries(seatInfo, function (seatData, callback) {
    var searchKey;
    if (seatData.providerSeatId && seatData.providerSeatId !== undefined && seatData.providerSeatId !== null && seatData.providerSeatId != 97700 && Number(offline) !== 1) {
      searchKey = seatData.providerSeatId;
    } else if (seatData.seatId) {
      searchKey = Number(seatData.seatId);
    }
    else if (Number(offline) !== 1 && String(eventType) === "events") {
      searchKey = event_type_id + seatData.pricePerSeat;
    }
    else if (Number(offline) !== 1) {
      searchKey = event_type_id + seatData.pricePerSeat;
    }

    var ops = {
      event_type: meta_data.entityType,
      event_id: meta_data.entityId,
      event_name: meta_data.entityName
    };
    util.log("Options are: " + JSON.stringify(options));
    util.log("Event ops are: " + JSON.stringify(ops));
    key = (meta_data.entityType === "events") ? ("event_prices." + seatData.seatId + ".price") : ("park_package_price." + seatData.seatId + ".ticket_price");

    if (!reqdata.overrideDetails[key]) {
      util.log("Error response is: " + JSON.stringify(reqdata.overrideDetails[key]));
      if (!reqdata.price_details[searchKey]) {
        util.log("search key " + searchKey + " not found in price object");
        return callback();
      } else {
        util.log("price for search key " + searchKey + " is " + reqdata.price_details[searchKey].price + " count is " + seatData.count);
        price = price + Number(reqdata.price_details[searchKey].price) * Number(seatData.count);
        return callback();
      }
    } else {
      util.log("Data present in override table have value: " + reqdata.overrideDetails[key].value);
      price = price + Number(reqdata.overrideDetails[key].value) * Number(seatData.count);
      return callback();
    }
  }, function (err) {
    if (err)
      cb(err);
    else {
      util.log("DB price is: " + price);
      return cb(null, price);
    }
  });
}

function true_price(price1, price2, con1, con2, cb) {
  if (Math.abs(price1 - price2) <= 1 && Math.abs(con1 - con2) <= 1)
    return cb(1);
  else
    return cb(0);
}

var prevalidate = {
  collect: function (req, res, next) {
    var cart_item;
    var fb_item;
    var merchandise_item;
    var fb_config;
    var merchandise_config;
    var addOnId;
    util.log(JSON.stringify(req.body));
    if (util.isArray(req.body.cart_items) && Number(req.body.cart_items.length) === 1)
      cart_item = req.body.cart_items[0];
    else {
      req.body.cart_items.forEach(function (item) {
        var config = item.configuration || item.fulfillment_req;
        if (item.is_ticket === true || config.is_ticket === true || (config.is_ticket && config.is_ticket === "true"))
          cart_item = item;
        if (item.is_F_B === true || config.is_F_B === true || (config.is_F_B && config.is_F_B === "true")) {
          fb_item = item;
          fb_config = config;
          addOnId = config && config.addOnId;
          if (addOnId === undefined || addOnId === "undefined" || addOnId === "") {
            var error = new Error("add on id not found for F&B item ! some one is trying to hack");
            return next(error);
          }
          req.addOnId = addOnId;
        }
        if (item.is_merchandise === true || config.is_merchandise === true || (config.is_merchandise && config.is_merchandise === "true")) {
          merchandise_item = item;
          merchandise_config = config;
          addOnId = config && config.addOnId;
          if (addOnId === undefined || addOnId === "undefined" || addOnId === "") {
            var error = new Error("add on id not found for meerchandise item! some one is trying to hack");
            return next(error);
          }
          req.addOnId = addOnId;
        }
      });

    }
    var config = cart_item.configuration || cart_item.fulfillment_req;
    req.is_ticket = (cart_item.is_ticket === true || (cart_item.is_ticket && cart_item.is_ticket === "true") || config.is_ticket === true || (config.is_ticket && config.is_ticket === "true")) ? true : false;
    var meta_data = cart_item.meta_data;

    util.log("Insurance value is  " + meta_data.insurance);
    var insuranceData = [];
    if (Number(meta_data.insurance) === 1) {
      req.body.cart_items.forEach(function (data) {
        if (data.meta_data.insurance_id && Number(data.meta_data.insurance_id) !== 0) {
          insuranceData.push(data);
          meta_data.insuranceItem = insuranceData;
        }
      });
      util.log("Insurance item is " + JSON.stringify(meta_data.insuranceItem));
    }

    var providerId = (meta_data && meta_data.providerId);
    var entityId = (meta_data && meta_data.entityId);
    var entityType = (meta_data && meta_data.entityType);
    req.cart_item = cart_item;
    req.fb_item = fb_item;
    req.merchandise_item = merchandise_item;
    req.fb_config = fb_config;
    req.merchandise_config = merchandise_config;
    req.config = config;
    req.meta_data = meta_data;
    req.params.providerId = providerId;
    req.reqdata = {};

    req.reqdata.entityId = entityId;
    req.reqdata.providerId = providerId;
    req.reqdata.entityType = entityType;
    req.reqdata.startTime = Date.now();
    var err;
    if (!config || !meta_data || isNaN(providerId)) {
      err = new Error('Missing meta_data,config or provider id');
    }
    util.log("Entity type is " + entityType);
    if (['events', 'themeparks'].indexOf(entityType) === -1) {
      err = new Error('Invalid request due to  invalid type' + entityType);
      return next(err);
    } else {
      req.entityType = entityType;
    }

    next(err);
  },
  cpData: function (req, res, next) {
    util.log("middleware: cpData");
    if (req.meta_data.insurance) {

      util.log("Doing insurance data validation");
      async.eachSeries(req.meta_data.insuranceItem, function (insuranceData, callback) {
        var insuranceMetadata = insuranceData.meta_data;
        var options = {};
        options.ticket_id = insuranceMetadata.ticket_id;
        options.insurance_id = insuranceMetadata.insurance_id;
        util.log("options is " + JSON.stringify(options));
        insuranceApi.select(options, function (err, res) {
          if (res && res.length) {
            util.log("options is " + JSON.stringify(res));
            res = res[0];

            if (Number(res.ticket_id) === Number(insuranceMetadata.ticket_id) && Number(res.premium) === Number(insuranceMetadata.premium) && Number(res.insurance_id) === Number(insuranceMetadata.insurance_id)) {
              util.log("success premium validation 1");
              if (Number(res.price) === Number(insuranceMetadata.max_claim_amount) && Number(res.price) === Number(insuranceMetadata.insured_item_price) && Number(insuranceData.configuration.price) === Number(insuranceMetadata.premium) && Number(insuranceData.configuration.insurance_id) === Number(insuranceMetadata.insurance_id)) {
                util.log("success premium validation 2");
                return callback();
              }
              else {
                err = new Error("Insurance Validation failure");
                err.title = "Please try after sometime";
                err.status = HttpStatus.PRECONDITION_FAILED;
                return callback(err);

              }

            }
            else {
              err = new Error("Insurance Validation failure");
              err.title = "Please try after sometime";
              err.status = HttpStatus.PRECONDITION_FAILED;
              return callback(err);

            }
          }
          err = new Error("Insurance Validation failure");
          err.title = "Please try after sometime";
          err.status = HttpStatus.PRECONDITION_FAILED;
          return callback(err);

        });


      }, function (err, res) {
          if (err) {
            err = new Error("Insurance Validation failure");
            err.title = "Please try after sometime";
            err.status = HttpStatus.PRECONDITION_FAILED;
            return next(err);
          }
          return next();


        });
    }
    else
      return next();
  },
  validatePrice: function (req, res, next) {//refactoring need
    util.log("middleware: validateprice");
    util.log("metadata is " + JSON.stringify(req.meta_data));


    var original_price;
    var cart_item = req.cart_item;
    var fb_item = req.fb_item;
    var merchandise_item = req.merchandise_item;
    var meta_data = req.meta_data;
    var config = req.config;

    var error;
    var original_conv_fee;
    var totalTicketPrice = meta_data.totalTicketPrice;
    var totalCommision = meta_data.totalCommision;
    var price = config.price;
    var ticketCount = 0;
    var table;
    var seatInfo = meta_data.seatInfo;
    var conv_fee = config.conv_fee;
    event_type_id = meta_data.entityId;
    provider_id = meta_data.providerId;
    eventType = meta_data.entityType;

    var eventOrpark_details = req.reqdata.eventOrpark_details;

    if (isNaN(totalTicketPrice) || isNaN(totalCommision) || isNaN(price) || isNaN(conv_fee)) {
      error = new Error('Price information missing. Cannot proceed');
      error.status = HttpStatus.PRECONDITION_FAILED;
      error.info = util.format('metaPrice:%s, configPrice:%s, metaFees:%s, configFees:%s', totalTicketPrice, price, totalCommision, conv_fee);
      return next(error);
    }
    var provider_ops = {
      id: provider_id
    };
    req.merchant_id = req.reqdata.provider_details.merchant_id;

    offline = req.reqdata.provider_details.offline;
    if (!req.meta_data.merchantId) {
      util.log("Adding merchant Id");
      req.meta_data.merchantId = req.reqdata.provider_details.merchant_id;
    }
    async.series([
      function checkingFields(callback) {

        async.eachSeries(seatInfo, checkData.bind(checkData, req.reqdata), function (err, res) {
          if (err)
            return callback(err);
          else
            return callback();

        });

      },
      function checkName(callback) {
        nameCheck(meta_data, req.reqdata, function (err, res) {
          if (err)
            return callback(err);
          else
            return callback();

        });

      },
      function get_db_price(callback) {
        get_price(meta_data, req.reqdata, function (err, res) {
          if (err) {
            error = new Error('Unable to fetch prices from db');
            return callback(error);
          } else {
            original_price = res;
            callback(null, original_price);
          }
        });
      },
      function get_db_fee(callback) {
        var options;
        options = {
          id: meta_data.entityId
        };
        table = (meta_data.entityType === "events") ? eventsApi : parksApi;
        options = {
          id: meta_data.providerId
        };

        seatInfo.forEach(function (seat) {
          ticketCount = ticketCount + Number(seat.count);
        });
        options = {
          fee: {
            convFee: req.reqdata.eventOrpark_details.conv_fee,
            pgCharges: req.reqdata.eventOrpark_details.pg_charges,
            paytmCommission: req.reqdata.eventOrpark_details.paytm_commission,
            noOfTickets: ticketCount,
            type: meta_data.entityType,
            entId: req.reqdata.eventOrpark_details.id,
            deliveryPrice: req.reqdata.eventOrpark_details.deliveryPrice,
            ticketDelivery: req.reqdata.eventOrpark_details.ticketDelivery,
            courier: req.reqdata.eventOrpark_details.courier,
            delivery: meta_data.delivery,
            price: meta_data.price
          },
          provider: {
            providerId: req.reqdata.provider_details.id,
            providerName: req.reqdata.provider_details.provider_key,
            offline: req.reqdata.provider_details.offline
          },
          seatInfo: seatInfo,
          entId: meta_data.entityId,
          type: meta_data.entityType
        };
        req.meta_data.courier = req.reqdata.eventOrpark_details.courier;
        calOriginal(options, req.reqdata.overrideDetails, function (err, res) {
          if (err)
            return callback(err);
          else {
            util.log("Conv fee object is: " + JSON.stringify(res));
            engine.calcConvFee(res, function (err, response) {
              if (err)
                return callback(err);
              else {
                if (meta_data.entityType === "events") {
                  response.totalCommision = (req.meta_data.delivery_charge !== undefined && Number(req.meta_data.delivery_charge) !== 0 && req.is_ticket !== true)
                                            ? parseFloat(response.totalCommision) + parseFloat(req.meta_data.delivery_charge)
                                            : parseFloat(response.newTotalCommision);
                }
                original_conv_fee = (Math.round((parseFloat(response.totalCommision) + 0.00001) * 100) / 100).toString();
                return callback();
              }
            });
          }
        });
      },
      function compare_data(callback) {
        true_price(original_price, price, original_conv_fee, conv_fee, function (res) {
          var price_ops = {
            config_price: price,
            db_price: original_price,
            conv_fee: conv_fee,
            db_fee: original_conv_fee,
            totalCommision: totalCommision
          };

          util.log("Price ops is: " + JSON.stringify(price_ops));
          if (res === 0) {
            error = new Error("Someone is trying to hack !");
            error.status = HttpStatus.PRECONDITION_FAILED;
            return callback(error);
          } else
            callback(null, null);
        });
      },
      function validateAddOnItemsPrice(callback) {
        if (req.addOnId && req.addOnId !== "undefined" && req.addOnId !== "") {
          var addOnData;
          var error;
          redis.get(req.addOnId + "final_prices", function (err, res) {
            if (!err && res) {
              try {
                addOnData = JSON.parse(res);
              }
              catch (err) {
                error = new Error("Failed to get data from redis for add ons price validation !");
                error.status = HttpStatus.PRECONDITION_FAILED;
                return callback(error);
              }
            }
            else {
              error = new Error("failed to get addOn prices in redis ");
              error.status = HttpStatus.PRECONDITION_FAILED;
              return callback(error);
            }
            if (addOnData) {
              if (fb_item) {
                var config = req.fb_config;
                var fbPriceError;
                var originPrices = addOnData.fbFee;
                var requestPrices = {
                  totalPrice: config.price,
                  totalCommission: config.conv_fee
                };
                if (Math.abs(originPrices.totalPrice - requestPrices.totalPrice) > 1 || Math.abs(originPrices.totalCommission - requestPrices.totalCommission) > 1) {
                  fbPriceError = new Error("Pricing mismatch in f&b items !");
                  fbPriceError.status = HttpStatus.PRECONDITION_FAILED;
                  return callback(fbPriceError);
                }
              }
              if (merchandise_item) {
                var config = req.merchandise_config;
                var merchPriceError;
                var originPrices = addOnData.merchFee;
                var requestPrices = {
                  totalPrice: config.price,
                  totalCommission: config.conv_fee
                };

                if (Math.abs(originPrices.totalPrice - requestPrices.totalPrice) > 1 || Math.abs(originPrices.totalCommission - requestPrices.totalCommission) > 1) {
                  merchPriceError = new Error("Pricing mismatch in merchandise items !");
                  merchPriceError.status = HttpStatus.PRECONDITION_FAILED;
                  return callback(merchPriceError);
                }
              }
              return callback(null, null);
            }
          });
        }
        else {
          return callback(null, null);
        }
      }
    ],
      function (err, result) {
        if (err) {
          error = new Error("Someone is trying to hack !");
          error.status = HttpStatus.PRECONDITION_FAILED;
          error.info = "Better luck next time";
          return next(error);
        } else {
          if (price != totalTicketPrice || parseInt(conv_fee) != parseInt(totalCommision)) {
            error = new Error("Someone is trying to hack !");
            error.status = HttpStatus.PRECONDITION_FAILED;
            error.info = util.format('metaPrice:%s, configPrice:%s, metaFees:%s, configFees:%s', totalTicketPrice, price, totalCommision, conv_fee);
            return next(error);
          }
          next();
        }
      }
    );
  },

  errorRespond: function (err, req, res, next) {
    var message = 'Please try again. There was a problem during order validation';
    var info = err.info || 'Failure during prevalidate call';
    util.log(err && err.message + ' ' + info);
    req.cart_item.error = message;
    req.body.error = message;
    util.log('Going to send Mail for pre-validation failure with content: ', err.stack);
    mailNotifier.send(err, req, res, function () {
      if (err) {
        util.log("Pre validation failure mail send operation failed");
      }
    });
    if ((req.url & req.url.indexOf('jsonp') > -1) ||
      (req.query && (req.query.callback || req.query.CALLBACK))) {
      res.jsonp(req.body);
    } else {
      res.json(req.body);
    }
  },
  merchantId: function (req, res, next) {
    util.log("middleware: merchantId");
    if (req.meta_data.merchantId)
      return next();
    var productId = req.meta_data.productId || req.cart_item.product_id;

    var options = { product_id: productId };
    entProviders.select(options, function (err, res) {
      if (err || !res)
        return next(err || new Error("Some error occured"));
      else if (!res.length) {
        req.meta_data.merchantId = req.merchant_id;
      }
      else {
        res = res[0];
        req.meta_data.merchantId = res.merchant_id;
        return next();
      }
    });
  },
  overrideMerchant: function (req, res, next) {
    util.log("middleware: overridemerchant");
    var productId = req.meta_data.productId || req.cart_item.product_id;

    util.log("Adding merchant_id");
    var options = { product_id: productId };
    entProviders.select(options, function (err, res) {
      if (err || !res)
        return next(err || new Error("Some error occured"));
      else if (!res.length) {
        req.meta_data.merchantId = req.merchant_id;
        options = {};
        var update_key = (req.meta_data.entityType === 'themeparks') ? ("parks." + req.meta_data.entityId + ".merchant_id") : ("events." + req.meta_data.entityId + ".merchant_id");
        if (!req.reqdata.overrideDetails[update_key])
          return next();
        req.meta_data.merchantId = req.reqdata.overrideDetails[update_key].value;
        return next();
      }
      else {
        res = res[0];
        req.meta_data.merchantId = res.merchant_id;
        options = {};
        var update_key = (req.meta_data.entityType === 'themeparks') ? ("parks." + req.meta_data.entityId + ".merchant_id") : ("events." + req.meta_data.entityId + ".merchant_id");
        if (!req.reqdata.overrideDetails[update_key])
          return next();
        req.meta_data.merchantId = req.reqdata.overrideDetails[update_key].value;
        return next();
      }
    });
  },
  emailValidation: function (req, res, next) {
    util.log("middleware: emailvalidation");
    if (Number(req.meta_data.providerId) !== 76)
      return next();
    if (!req.meta_data.passenger)
      return next();
    util.log("Entered in email and number validation");
    var error;
    var passenger = util.isArray(req.meta_data.passenger) ? req.meta_data.passenger : [
      [req.meta_data.passenger]
    ];
    var paxDetails = {};
    passenger[0].forEach(function (f) {

      if (f.title.toLowerCase().indexOf('mobile') !== -1 || f.title.toLowerCase().indexOf('phone') !== -1) {
        paxDetails.phone = f.applied || "Not Entered";

      }
      else if (f.title.toLowerCase().indexOf('email') !== -1) {
        paxDetails.email = f.applied || "Not Entered";

      }
      else if (f.title.toLowerCase().indexOf('name') !== -1) {
        paxDetails.name = f.applied || "-1";

      }
    });


    var emailRegex = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
    var numberRegex = /^\d{10}$/;
    var nameRegex = /^[a-zA-Z ]{2,30}$/;
    paxDetails.email = String(paxDetails.email && String(paxDetails.email).trim());
    paxDetails.name = String(paxDetails.name && String(paxDetails.name).trim());
    paxDetails.phone = Number(paxDetails.phone && String(paxDetails.phone).trim());

    util.log(paxDetails.email + "<<<" + paxDetails.phone + "<<<" + paxDetails.name);

    var a = emailRegex.test(paxDetails.email);
    var b = numberRegex.test(paxDetails.phone);
    var c = nameRegex.test(paxDetails.name);

    util.log(a + "<<<" + b + "<<<" + c);
    if (paxDetails.name && !c) {
      error = new Error("Please Enter valid name : " + paxDetails.name);
      error.status = HttpStatus.PRECONDITION_FAILED;
      error.title = "Please Enter valid name";
      return next(error);
    }
    else if (paxDetails.email && !a) {
      error = new Error("Please Enter valid email: " + paxDetails.email);
      error.status = HttpStatus.PRECONDITION_FAILED;
      error.title = "Please Enter valid email";
      return next(error);
    }
    else if (paxDetails.phone && !b) {
      error = new Error("Please Enter valid  mobile number: " + paxDetails.phone);
      error.status = HttpStatus.PRECONDITION_FAILED;
      error.title = "Please Enter valid  mobile number";
      return next(error);
    }
    else
      return next();
  },

  ticketCheck: function (req, res, next) {
    if (Number(req.meta_data.providerId) !== 242)
      return next();
    var price = 0;
    var error;
    var bookingObject = {};
    bookingObject.tickets = {};
    var startTime = req.meta_data.startTime;
    var seatInfo = req.meta_data.seatInfo;
    var eventId = req.meta_data.entityId;
    async.eachSeries(seatInfo, function (seat, callback) {
      price = parseFloat(seat.pricePerSeat) + parseFloat(req.reqdata.price_details[seat.providerSeatId].convFee);

      bookingObject.tickets[seat.seatType] = {
        "price": price,
        "originalPrice": price,
        "quantity": seat.count,
        "timestamp": new Date(startTime).getTime()
      };
      return callback();
    },
      function (err, res) {
        if (err)
          return next(err);
        util.log("Booking Object is " + JSON.stringify(bookingObject));
        getEventId(eventId, function (err, res) {
          if (err)
            return next(err);
          var eventId = res;
          eventhigh.statusCheck(bookingObject, eventId, function (err, res) {
            util.log("Inventory check res from eventshigh is " + JSON.stringify(res));
            if (err || !res) {
              error = new Error("Tickets sold out . Try for some other package/dates");
              error.status = HttpStatus.PRECONDITION_FAILED;
              error.title = "Tickets sold out . Try for some other package/dates";
              return next(error);
            }
            else if (res && res.error) {
              error = new Error("Tickets sold out . Try for some other package/dates");
              error.status = HttpStatus.PRECONDITION_FAILED;
              error.title = "Tickets sold out . Try for some other package/dates";
              return next(error);
            }
            else
              return next();
          });
        });
      });

  },
  ticketStatus: function (req, res, next) {
    var error;
    if (Number(req.meta_data.providerId) !== 258)
      return next();
    util.log("Entered in ticket validation");

    var bookingObject = {};
    bookingObject.tickets = {};
    var seatInfo = req.meta_data.seatInfo;
    var eventId = req.meta_data.entityId;
    async.eachSeries(seatInfo, function (seat, callback) {

      bookingObject.tickets[seat.providerSeatId] = seat.count;

      return callback();
    },
      function (err, res) {
        if (err)
          return next(err);
        util.log("Booking Object is " + JSON.stringify(bookingObject));
        getEventId(eventId, function (err, res) {
          if (err)
            return next(err);
          bookingObject.event_id = res;
          bookingObject.tickets = JSON.stringify(bookingObject.tickets);

          eventnow.checkout(bookingObject, function (err, res) {
            if (err || !res || (res && res.response && String(res.response.validation) === "false")) {
              util.log("tickets sold out");
              error = new Error("Tickets for this category are out of stock! Please try for fewer tickets or some other event.");
              error.status = HttpStatus.PRECONDITION_FAILED;
              error.title = "Tickets for this category are out of stock! Please try for fewer tickets or some other event.";
              return next(error);
            }
            else
              return next();
          });
        });
      });
  },
  meraEvents: function (req, res, next) {
    util.log("middleware: meraevents");
    if (Number(req.meta_data.providerId) !== 31)
      return next();
    util.log("Entered in meraEvents ticket validation");
    var key = req.meta_data.entityId + "-" + req.meta_data.ticketCount;
    util.log("key is " + key);
    redis.get(key, function (err, res) {
      util.log("res is " + res);
      if (!err && res)
        return next();

      var error = new Error("Tickets not available . Please try for other Package/Event");
      error.status = HttpStatus.PRECONDITION_FAILED;
      error.title = "Tickets not available . Please try for other Package/Event";
      return next(error);
    });
  },
  pdpTicketCountCheck: function (req, res, next) {


    if (!req.res_data || (req.res_data && req.res_data.provider_id === undefined))
      return next();

    if (Number(req.res_data.provider_id) !== 76) {
      req.res_data.is_allowed = 1;
      return next();
    }

    if (!req.query) {
      req.res_data.is_allowed = 1;
      return next();
    }
    util.log("Doing ticket count checking");

    util.log("providerId is " + req.res_data.provider_id);
    util.log("orderLimitEntity is " + JSON.stringify(orderLimitEntity));

    util.log("order limit enity with event is " + orderLimitEntity[req.res_data.id]);

    orderLimit = (orderLimitEntity[req.res_data.id] !== undefined) ? orderLimitEntity[req.res_data.id] : config.orderLimit;

    var ticketCount = 0;
    if (req.query.customer_id === undefined) {
      req.res_data.is_allowed = 1;
      return next();
    }
    util.log("order limit  is " + orderLimit);
    util.log("req customer id is " + req.query.customer_id);
    util.log("req name  is " + req.res_data.name);
    util.log("req id is " + req.res_data.id);

    var customer_id = req.query.customer_id;
    var key = customer_id + "-" + req.res_data.id;
    redis.get(key, function (err, res) {
      if (err || !res) {
        req.res_data.is_allowed = 1;
        return next();
      }
      else {
        util.log("Ticket count is " + res);
        ticketCount = res;

        util.log("Order Limit is" + orderLimit);

        if (Number(orderLimit) > ticketCount) {
          req.res_data.is_allowed = 1;
          return next();
        }
        else {
          req.res_data.is_allowed = 0;
          return next();
        }
      }
    });

  },
  pdpOrderCountCheck: function (req, res, next) {


    if (!req.res_data || (req.res_data && req.res_data.provider_id === undefined))
      return next();

    if (Number(req.res_data.provider_id) !== 76) {
      req.res_data.is_allowed = 1;
      return next();
    }

    if (!req.query) {
      req.res_data.is_allowed = 1;
      return next();
    }
    util.log("Doing order count checking");

    util.log("providerId is " + req.res_data.provider_id);
    var userOrderLimit = config.userOrderLimit;
    var eventUserOrderLimit = userOrderLimit[req.res_data.id] || Number.POSITIVE_INFINITY;
    util.log("Event User order Limit is " + eventUserOrderLimit);
    if (req.query.customer_id === undefined) {
      req.res_data.is_allowed = 1;
      return next();
    }
    util.log("customer id is " + req.query.customer_id);
    util.log("Event name  is " + req.res_data.name);
    util.log("Event id is " + req.res_data.id);

    var customer_id = req.query.customer_id;

    var key = "order-" + customer_id + "-" + req.res_data.id;

    redis.get(key, function (err, res) {
      if (err || !res) {
        req.res_data.is_allowed = 1;
        return next();
      }
      else {
        util.log("Order count is " + res);

        if (Number(eventUserOrderLimit) > res) {
          req.res_data.is_allowed = 1;
          return next();
        }
        else {
          req.res_data.is_allowed = 0;
          return next();
        }

      }
    });

  },
  ticketCountCheck: function (req, res, next) {
    util.log("middleware: ticketcountcheck");
    if (Number(req.meta_data.providerId) !== 76)
      return next();


    if (!req.query)
      return next();
    var error;
    var userOrderLimit = config.userOrderLimit;
    var eventUserOrderLimit = userOrderLimit[req.meta_data.entityId] || Number.POSITIVE_INFINITY;
    util.log("Event User order Limit is " + eventUserOrderLimit);

    util.log("Doing ticket count checking");
    orderLimit = (orderLimitEntity[req.meta_data.entityId]) ? orderLimitEntity[req.meta_data.entityId] : config.orderLimit;

    util.log("order Limit is" + orderLimit);

    var ticketCount = 0;
    var orderCount = 0;
    var passenger = util.isArray(req.meta_data.passenger) ? req.meta_data.passenger : [
      [req.meta_data.passenger]
    ];
    var paxDetails = {};
    passenger[0].forEach(function (f) {

      if ((f.title.toLowerCase()).indexOf('name') > -1) {
        paxDetails.name = f.applied;

      } else if ((f.title.toLowerCase()).indexOf('mobile') > -1 || (f.title.toLowerCase()).indexOf('number') > -1 || (f.title.toLowerCase()).indexOf('phone') > -1) {
        paxDetails.phone = f.applied;

      }
    });


    var customer_id = (req.query && req.query.client && req.query.client == "androidapp" && !req.meta_data.customer_id) ? paxDetails.phone : (req.query.customer_id || req.meta_data.customer_id || paxDetails.phone);

    req.meta_data.customer_id = customer_id;

    if (req.query && req.query.client && req.query.client == "androidapp")
      req.meta_data.customer_id = String(customer_id);

    if (customer_id === undefined)
      return next();


    var customerkey = paxDetails.phone;


    util.log("Customer Id is " + customer_id);
    var seatInfo = req.meta_data.seatInfo;
    var key = customer_id + "-" + req.meta_data.entityId;
    var orderKey = "order-" + customer_id + "-" + req.meta_data.entityId;

    seatInfo.forEach(function (data) {

      orderCount = Number(orderCount) + Number(data.count);

    });
    util.log("order key is" + orderKey);
    redis.get(orderKey, function (err, res) {
      if (res) {
        util.log("previous user order count is " + res);
        if (res >= eventUserOrderLimit) {
          error = new Error("You have exhausted your order limit of " + eventUserOrderLimit + " order per user for this event");
          error.status = HttpStatus.PRECONDITION_FAILED;
          error.title = "You have exhausted your order limit of " + eventUserOrderLimit + " order per user for this event";
          return next(error);
        }
      }
      redis.get(key, function (err, res) {
        if (err || !res) {
          if (Number(orderLimit) >= orderCount) {
            redis.set(customerkey, customer_id, "EX", 60 * 60, function (err, res) {

              util.log("Key set successfully");
              return next();

            });
          }
          else {
            error = new Error("You can book maximum " + orderLimit + " tickets for this event");
            error.status = HttpStatus.PRECONDITION_FAILED;
            error.title = "You can book maximum " + orderLimit + " tickets for this event";
            return next(error);
          }
        }
        else {
          util.log("Ticket count is " + res);
          ticketCount = res;
          var totalOrdered = Number(ticketCount) + Number(orderCount);
          util.log("Order Limit is" + orderLimit + "<< orderCount is " + totalOrdered);

          if (Number(orderLimit) >= totalOrdered) {
            redis.set(customerkey, customer_id, "EX", 60 * 60, function (err, res) {

              util.log("Key set successfully");
              return next();

            });
          }
          else {
            var remainingCount = Number(orderLimit) - Number(res);

            if (remainingCount <= 0) {
              errorMessage = "You have already exhausted your ticket limit of " + orderLimit + " tickets per user for this event";
              remainingCount = Number(orderLimit) - Number(res);
            }
            else
              errorMessage = "You already booked " + res + " tickets out of ticket limit of " + orderLimit + " tickets per user per event.You can book maximum " + remainingCount + " ticket(s) in this order.";

            error = new Error(errorMessage);
            error.status = HttpStatus.PRECONDITION_FAILED;
            error.title = errorMessage;
            return next(error);
          }

        }
      });
    });

  },
  checkOrderLimit: function (req, res, next) {
    util.log("middleware: checkorderlimit");
    if (Number(req.meta_data.providerId) !== 76)
      return next();

    var error;
    var orderLimit = config.eventOrderLimit;
    orderLimit = orderLimit[req.meta_data.entityId] || Number.POSITIVE_INFINITY;

    util.log("Ticket limit per user for this event  is " + orderLimit);
    var maxTicketCount = orderLimit;

    var meta_data = req.meta_data;

    if (meta_data.ticketCount > maxTicketCount) {
      error = new Error("You can book maximum " + maxTicketCount + " tickets per order for this event");
      error.status = HttpStatus.PRECONDITION_FAILED;
      error.title = "You can  book maximum " + maxTicketCount + " tickets per order for this event";
      return next(error);
    }

    return next();

  },
  mulPack: function (req, res, next) {
    util.log("middleware: mulpack");
    if (Number(req.meta_data.providerId) !== 76)
      return next();

    var error;
    var mul_pack = config.mulPack;
    mul_pack = (Number(mul_pack[req.meta_data.entityId]) == 0) ? 0 : 1;

    util.log("Value of mul_pack is " + mul_pack);
    var seatInfo = req.meta_data.seatInfo;

    if (mul_pack)
      return next();
    else {
      var count = 0;
      seatInfo.forEach(function (seat) {
        if (Number(seat.count) > 0) {
          count++;
        }
      });
      util.log("package count is " + count);
      if (count > 1) {
        error = new Error("Multiple category ticket selection is not allowed. Please select tickets from single category.");
        error.status = HttpStatus.PRECONDITION_FAILED;
        error.title = "Multiple category ticket selection is not allowed. Please select tickets from single category.";
        return next(error);
      }
      else
        return next();
    }
  },
  setCategory: function (req, res, next) {

    //this function set category and category_id in metadata
    if (req.meta_data.category === undefined)
      return next();
    else {
      util.log("this function set category and category_id in metadata ");
      req.meta_data.categoryObject = {};
      entCategoryMappers.select({ ent_id: req.meta_data.entityId }, function (err, res) {

        if (err || !res || !res.length)
          return next();
        else if (res.length) {
          req.meta_data.categoryObject.id = res[0].category_id;
          entCategories.select({ id: res[0].category_id }, function (err, res) {

            if (err || !res || !res.length)
              return next();
            else if (res.length) {
              req.meta_data.categoryObject.name = res[0].name;
              req.meta_data.category = res[0].name;
              return next();
            }
          });
        }
      });
    }
  },
  insider: function (req, res, next) {//refactoring need
    util.log("middleware: insider");
    if (Number(req.meta_data.providerId) !== 76)
      return next();
    req.reqdata.providerId = Number(req.meta_data.providerId);
    util.log("Entered in insider block call");
    var deliveryObject = {};
    var error;
    var map = {};
    var finalForm;
    var items_to_cart = [];
    var seat_providerId_map = {};
    var seatData = req.meta_data.insiderSeats;
    var ticketTypeTedX = req.meta_data.seatInfo && req.meta_data.seatInfo[0] && req.meta_data.seatInfo[0].seatType;
    var paxDetails = {};
    var deliveryAddress = {};
    var addressOverrideMap = {
      'Address1': 'Address_1',
      'Address2': 'Address_2',
      'AddressType': 'Address_Type'
    }
    var passenger = util.isArray(req.meta_data.passenger) ? req.meta_data.passenger : [
      [req.meta_data.passenger]
    ];
    var ticketPrice = 0;
    var newId;
    var deliveryAddress1 = {};
    var seatInfo = req.meta_data.seatInfo;
    var seatArray = [];
    passenger[0].forEach(function (f) {

      if ((f.title.toLowerCase()).indexOf('email') > -1) {
        req.meta_data.contact_email = f.applied;
      }

      if ((f.title.toLowerCase()).indexOf('name') > -1) {
        paxDetails.name = f.applied;
        deliveryAddress["Name"] = f.applied;
        deliveryAddress1["Name"] = f.applied;

      } else if ((f.title.toLowerCase()).indexOf('mobile') > -1 || (f.title.toLowerCase()).indexOf('number') > -1 || (f.title.toLowerCase()).indexOf('phone') > -1) {
        paxDetails.phone = f.applied;
        deliveryAddress["Mobile"] = f.applied;
        deliveryAddress1["Mobile"] = f.applied;
      }

      if (String(f.info_type) === "delivery" && ((f.title.toLowerCase()).indexOf('address1') > -1 || (f.title.toLowerCase()).indexOf('address2') > -1 || (f.title.toLowerCase()).indexOf('addresstype') > -1)) {
        deliveryAddress[addressOverrideMap[f.title]] = f.applied;
        deliveryAddress1[addressOverrideMap[f.title].toLowerCase().trim()] = f.applied;
        req.meta_data.deliveryAddress = deliveryAddress;
        f.title = addressOverrideMap[f.title];
      }

      else if (String(f.info_type) === "delivery") {
        deliveryAddress[f.title] = f.applied;
        deliveryAddress1[f.title.toLowerCase().trim()] = f.applied;
        req.meta_data.deliveryAddress = deliveryAddress;
      }

    });

    var key = "";

    if (seatData) {
      seatInfo.forEach(function (seat) {
        key = key + seat.seatId + seat.count;
        key = key + seat.providerSeatId + seat.count;

      });
    }
    else {
      seatInfo.forEach(function (seat) {
        key = key + seat.providerSeatId + seat.count;
      });
    }
    key = paxDetails.name + key + paxDetails.phone;


    util.log("Key is" + key);
    redis.get(key, function (err, res) {
      if (!err && res)
        newId = res;

      seatInfo.forEach(function (seat) {
        seat_providerId_map[seat.providerSeatId] = seat;
      });


      async.series([populateData, checkRSVP, populateParams, addToInsiderCartWithParams, addToInsiderCartWithoutParams, redisSave], function (err) {
        if (err && err.status == "RSVP") {
          req.meta_data.is_rsvp = 1;
          return next();

        }
        else if (err) {
          error = new Error(err);
          error.status = HttpStatus.PRECONDITION_FAILED;
          error.title = err;
          return next(error);

        }
        return next();
      });

      function populateData(lcb) {
        passenger.forEach(function (pax) {
          pax.forEach(function (pax1) {
          });

        });
        util.log("passenger info  is " + JSON.stringify(passenger));
        var formKey = "";
        var oldFormKey;//for older app versios do not get pax details bcs no hold call goes before prevalidate
        seatInfo.forEach(function (seat) {
          formKey = formKey + seat.providerSeatId + "-" + seat.count;
          ticketPrice = Number(ticketPrice) + Number(seat.pricePerSeat);

        });
        oldFormKey = formKey;
        formKey = formKey + "#" + paxDetails.name + "#" + paxDetails.phone;
        formKey = formKey.trim();
        util.log("Form key is" + formKey);
        redis.get(formKey, function (err, res) {
          if (err || !res) {
            redis.get(oldFormKey, function (err, result) {
              res = result;
            });
          }
          util.log("Form res is " + res);
          if (res && res !== null) {
            res = JSON.parse(res);
            finalForm = res;
            util.log("finalForm is " + JSON.stringify(finalForm));

            finalForm.forEach(function (data) {
              data.forEach(function (data1) {
                passenger.forEach(function (data2) {
                  data2.forEach(function (data3) {
                    if (data1.title === data3.title) {
                      data1.applied = data3.applied;

                    }

                  });
                });
              });
            });
            passenger = finalForm;
          }
          util.log("passenger info  is " + JSON.stringify(passenger));
          util.log("Delivery address is " + JSON.stringify(req.meta_data.deliveryAddress));
          if (!req.meta_data.deliveryAddress || (req.meta_data.deliveryAddress && Object.keys(req.meta_data.deliveryAddress).length < 3)) {
            passenger[0].forEach(function (f) {
              if (String(f.info_type) === "delivery" && ((f.title.toLowerCase()).indexOf('address1') > -1 || (f.title.toLowerCase()).indexOf('address2') > -1 || (f.title.toLowerCase()).indexOf('addresstype') > -1)) {
                deliveryAddress[addressOverrideMap[f.title]] = f.applied;
                deliveryAddress1[addressOverrideMap[f.title].toLowerCase().trim()] = f.applied;
                req.meta_data.deliveryAddress = deliveryAddress;
                f.title = addressOverrideMap[f.title];
              }

              else if (String(f.info_type) === "delivery") {
                deliveryAddress[f.title] = f.applied;
                deliveryAddress1[f.title.toLowerCase().trim()] = f.applied;
                req.meta_data.deliveryAddress = deliveryAddress;
              }

            });
          }

          return lcb();

        });
      }
      function checkRSVP(lcb) {
        var options = {
          event_id: req.meta_data.entityId
        };
        util.log("options is" + JSON.stringify(options));
        var custom_info = JSON.parse(req.reqdata.priceDetailsArray[0].custom_info);
        if (custom_info.item_name && custom_info.item_name == "RSVP") {
          util.log("Event is rsvp event");
          var error = new Error("Event is rsvp event");
          error.status = "RSVP";
          return lcb(error);
        }
        return lcb();
      }

      function populateParams(lcb) {


        passenger.forEach(function (pax) {

          var params_array = [];
          var provider_seat_id = pax[0].provider_seat_id;
          if (map[provider_seat_id] === undefined) {
            map[provider_seat_id] = {
              item_user_params: [],
              inventory_user_params: []
            };
          }
          pax.forEach(function (field) {
            if (field.type !== 'heading') {
              var obj = {
                name: field.id.split(':')[0],
                value: String(field.applied)
              };
              if (field.info_type === 'item_params') {
                map[provider_seat_id].item_user_params.push(obj);
              } else if (field.info_type === 'inventory_params') {
                params_array.push(obj);
              }
              else if (field.info_type === "delivery") {
                deliveryObject[field.title.toLowerCase().trim()] = field.applied;

              }
            }

          });
          if (tedXEvents.indexOf(Number(req.reqdata.entityId)) > -1) {
            params_array.push({ name: "where_did_you_hear_about_us", value: "insider.in" });
            params_array.push({ name: "accept_rules", value: "on" });
            if (ticketTypeTedX === "Gold Ticket" || ticketTypeTedX === "Platinum Ticket" || ticketTypeTedX === "Silver Ticket" || ticketTypeTedX === "Silver Preferred Ticket" || ticketTypeTedX === "Student Ticket") {
              params_array.push({ name: "note_parking", value: "on" });
            }
            if (ticketTypeTedX === "Silver Ticket" || ticketTypeTedX === "Silver Preferred Ticket" || ticketTypeTedX === "Student Ticket") {
              params_array.push({ name: "note_food", value: "on" });
            }
          }
          if (comicConEvents.indexOf(Number(req.reqdata.entityId)) > -1) {
            params_array.push({ name: "comic_con_city2", value: "" });
          }

          if (params_array.length) {
            map[provider_seat_id].inventory_user_params.push({
              "params": params_array
            });
          }

        });

        return lcb();
      }

      function addToInsiderCartWithParams(lcb) {

        Object.keys(map).forEach(function (m) {
          if (m && seat_providerId_map[m] && map[m]) {

            if (Number(seat_providerId_map[m].count) > 0) {
              var cart_obj = {
                "_id": m,
                "count": seat_providerId_map[m].count,
                "item_user_params": map[m].item_user_params,
                "inventory_user_params": map[m].inventory_user_params
              };
              if (seatData) {
                seatArray = [];
                seatData.forEach(function (seats) {
                  if (seats.category === seat_providerId_map[m].seatType) {
                    seatArray.push(seats);
                  }
                });
                cart_obj.seats = seatArray;
              }
              items_to_cart.push(cart_obj);
              delete seat_providerId_map[m];
            }
          }

        });
        return lcb();
      }

      function addToInsiderCartWithoutParams(lcb) {
        Object.keys(seat_providerId_map).forEach(function (m) {

          if (Number(seat_providerId_map[m].count) > 0) {
            var cart_obj = {
              "_id": m,
              "count": seat_providerId_map[m].count
            };
            if (seatData) {
              seatArray = [];
              seatData.forEach(function (seats) {
                if (seats.category === seat_providerId_map[m].seatType) {
                  seatArray.push(seats);
                }
              });
              cart_obj.seats = seatArray;
            }
            items_to_cart.push(cart_obj);
          }
        });
        util.log("Items_to_cart is" + JSON.stringify(items_to_cart));
        util.log("Items_to_cart is" + JSON.stringify(deliveryObject));
        var blockOptions = {};
        blockOptions.items = items_to_cart;


        if (req.meta_data.deliveryAddress && Object.keys(req.meta_data.deliveryAddress).length > 0) {

          Object.keys(req.meta_data.deliveryAddress).forEach(function (key) {
            if (key.toLowerCase().trim() === "pincode") {
              util.log("delivery address already present");
              util.log("delivery address already present in metadata" + JSON.stringify(req.meta_data.deliveryAddress));
              deliveryObject = deliveryAddress1;
              util.log("delivery Object already present" + JSON.stringify(deliveryObject));
            }
          });
        }

        if (Object.keys(deliveryObject).length > 0) {
          blockOptions.delivery_details = deliveryObject;
        }

        if (newId) {
          newId = JSON.parse(newId);
          blockOptions._id = newId._id;
          blockOptions.items = newId.items;
        }

        req.reqdata.supplierStartTime = Date.now();
        util.log("Final request options are " + JSON.stringify(blockOptions));
        insiderApi.addToCart(blockOptions, function (err, res) {

          req.reqdata.supplierUrl = "insider/holdCall";
          req.reqdata.supplierEndTime = Date.now();
          if (err && (err.status && err.status == HttpStatus.GATEWAY_TIMEOUT)) {
            req.reqdata.status = 0;
            util.log("err response is " + JSON.stringify(err));
            return lcb("Some issue at provider side . Please try again after sometime");
          }
          if (err || !res) {
            req.reqdata.status = 0;
            util.log("err response is " + JSON.stringify(err));
            if (Object.keys(deliveryObject).length > 0) {
              return lcb("Pincode is not valid/serviceable .Please enter other pincode");
            }
            return lcb("Unable to get response from provider");
          }
          util.log('In addToInsiderCartWithoutParams for insider' + JSON.stringify(res));
          err = '';
          res.items.forEach(function (r) {
            if (r && r.result && r.result.status && r.result.status == 410 && r.result.result == "User has already rsvped") {
              error = false;
            }
            else if (r && r.result && r.result.status && r.result.status != 200) {
              error = true;
              err = r.result.result;
            }
            else if (r && !r.result && ticketPrice != 0) {
              error = true;
              err = "Please update your app for booking this event.";

            }
          });

          if (error) {
            req.reqdata.status = 0;
            util.log('Error adding the selected item at insider cart...Aborting' + err);
            return lcb(err);
          }
          req.reqdata.status = 1;
          newId = res;
          req.meta_data.eventsCommission = res.commission_amount.toFixed(2);//setting event commission in metadata for payout
          util.log("Final metadata is " + JSON.stringify(req.meta_data));
          return lcb();
        });
      }


      function redisSave(lcb) {


        util.log("Going to set key" + key);
        newId = JSON.stringify(newId);
        redis.set(key, newId, "EX", 60 * 10, function (err, res) {
          return lcb();

        });
      }
    });

  },
  pincode: function (req, res, next) {// refactoring need 
    var data = req.body;
    req.reqdata.providerId = Number(data.providerId);
    if (Number(data.providerId) !== 76) {
      req.res_data = {
        "status": "ok"
      };
      return next();
    }

    util.log("Entered in insider pincode validation / block call");

    var error;
    var map = {};
    var finalForm;
    var items_to_cart = [];
    var seat_providerId_map = {};
    var ticketTypeTedX = data.seatInfo && data.seatInfo[0] && data.seatInfo[0].seatType;
    var seatData = data.insiderSeats;
    if (data.insiderSeats) {
      data.seatInfo.forEach(function (seatData) {
        seatData.seatId = '';
        seatData.matchCount = 0;
      });
      var length, count = 0;
      length = data.insiderSeats.length;
      data.seatInfo.forEach(function (seatData) {
        data.insiderSeats.forEach(function (seats) {
          if (String(seats.category) === String(seatData.seatType)) {
            seatData.matchCount++;
            seatData.seatId = (Number(seatData.matchCount) === Number(seatData.count)) ? (seatData.seatId + seats.name) : (seatData.seatId + seats.name + ",");
          }
        });
      });
    }
    var paxDetails = {};
    var deliveryObject = {};

    var passenger = util.isArray(data.passenger) ? data.passenger : [
      [data.passenger]
    ];
    var ticketPrice = 0;
    var newId = null;
    var seatInfo = data.seatInfo;
    var seatArray = [];


    passenger[0].forEach(function (f) {

      if ((f.title.toLowerCase()).indexOf('name') > -1) {
        paxDetails.name = f.applied;

      } else if ((f.title.toLowerCase()).indexOf('mobile') > -1 || (f.title.toLowerCase()).indexOf('number') > -1 || (f.title.toLowerCase()).indexOf('phone') > -1) {
        paxDetails.phone = f.applied;

      }
    });


    var key = "";

    if (seatData) {
      seatInfo.forEach(function (seat) {
        key = key + seat.seatId + seat.count;
        key = key + seat.providerSeatId + seat.count;
      });
    }
    else {
      seatInfo.forEach(function (seat) {
        key = key + seat.providerSeatId + seat.count;
      });
    }
    key = paxDetails.name + key + paxDetails.phone;

    util.log("Key is" + key);
    redis.get(key, function (err, res) {
      if (!err && res)
        newId = res;

      seatInfo.forEach(function (seat) {

        seat_providerId_map[seat.providerSeatId] = seat;
      });

      async.series([populateData, checkRSVP, populateParams, addToInsiderCartWithParams, addToInsiderCartWithoutParams, redisSave], function (err) {

        if (err && err.status == "RSVP") {
          req.res_data = {
            "status": "ok"
          };
          return next();

        }
        else if (err) {
          error = new Error(err);
          error.status = HttpStatus.PRECONDITION_FAILED;
          error.title = err;
          return next(error);
        }
        return next();
      });

      function populateData(lcb) {
        // passenger.forEach(function (pax) {
        // });
        util.log("passenger info  is " + JSON.stringify(passenger));
        var formKey = "";
        seatInfo.forEach(function (seat) {
          formKey = formKey + seat.providerSeatId + "-" + seat.count;
          ticketPrice = Number(ticketPrice) + Number(seat.pricePerSeat);
        });
        formKey = formKey + "#" + paxDetails.name + "#" + paxDetails.phone;
        formKey = formKey.trim();
        util.log("Form key is" + formKey);
        var formData = JSON.stringify(passenger);

        redis.set(formKey, formData, 'EX', 20 * 60, function (err, res) {
          util.log("Updated form set in redis");
          return lcb();
        });
      }
      function checkRSVP(lcb) {
        var options = {
          provider_seat_id: data.seatInfo[0].providerSeatId
        };
        util.log("options is" + JSON.stringify(options));
        priceAPI.events.select(options, function (err, res) {
          //util.log("response is " + JSON.stringify(res));
          if (res && res.length) {
            res = res[0];
            req.reqdata.entityId = res.event_id;
            var custom_info = JSON.parse(res.custom_info);
            util.log("Item name  is " + custom_info.item_name);
            if (custom_info.item_name && custom_info.item_name == "RSVP") {



              util.log("Event is rsvp event");
              var error = new Error("Event is rsvp event");
              error.status = "RSVP";
              return lcb(error);
            }
            else
              return lcb();
          }
          else
            return lcb();
        });
      }
      function populateParams(lcb) {

        util.log("passenger info is" + JSON.stringify(passenger));
        passenger.forEach(function (pax) {

          var params_array = [];
          var provider_seat_id = pax[0].provider_seat_id;
          if (map[provider_seat_id] === undefined) {
            map[provider_seat_id] = {
              item_user_params: [],
              inventory_user_params: []
            };
          }


          pax.forEach(function (field) {
            if (field.type !== 'heading') {
              var obj = {
                name: field.id.split(':')[0],
                value: String(field.applied)
              };
              if (field.info_type === 'item_params') {
                map[provider_seat_id].item_user_params.push(obj);
              } else if (field.info_type === 'inventory_params') {
                params_array.push(obj);
              }
              else if (field.info_type === "delivery") {
                deliveryObject[field.title.toLowerCase().trim()] = field.applied;

              }
            }


          });
          if (tedXEvents.indexOf(Number(req.reqdata.entityId)) > -1) {
            params_array.push({ name: "where_did_you_hear_about_us", value: "insider.in" });
            params_array.push({ name: "accept_rules", value: "on" });
            if (ticketTypeTedX === "Gold Ticket" || ticketTypeTedX === "Platinum Ticket" || ticketTypeTedX === "Silver Ticket" || ticketTypeTedX === "Silver Preferred Ticket" || ticketTypeTedX === "Student Ticket") {
              params_array.push({ name: "note_parking", value: "on" });
            }
            if (ticketTypeTedX === "Silver Ticket" || ticketTypeTedX === "Silver Preferred Ticket" || ticketTypeTedX === "Student Ticket") {
              params_array.push({ name: "note_food", value: "on" });
            }
          }
          if (comicConEvents.indexOf(Number(req.reqdata.entityId)) > -1) {
            params_array.push({ name: "comic_con_city2", value: "" });
          }

          if (params_array.length) {
            map[provider_seat_id].inventory_user_params.push({
              "params": params_array
            });
          }

        });

        return lcb();
      }

      function addToInsiderCartWithParams(lcb) {

        Object.keys(map).forEach(function (m) {
          if (m && seat_providerId_map[m] && map[m]) {

            if (Number(seat_providerId_map[m].count) > 0) {
              var cart_obj = {
                "_id": m,
                "count": seat_providerId_map[m].count,
                "item_user_params": map[m].item_user_params,
                "inventory_user_params": map[m].inventory_user_params
              };
              if (seatData) {
                seatArray = [];
                seatData.forEach(function (seats) {
                  if (seats.category === seat_providerId_map[m].seatType) {
                    seatArray.push(seats);
                  }
                });
                cart_obj.seats = seatArray;
              }
              items_to_cart.push(cart_obj);
              delete seat_providerId_map[m];
            }
          }

        });
        return lcb();
      }

      function addToInsiderCartWithoutParams(lcb) {
        Object.keys(seat_providerId_map).forEach(function (m) {

          if (Number(seat_providerId_map[m].count) > 0) {
            var cart_obj = {
              "_id": m,
              "count": seat_providerId_map[m].count
            };
            if (seatData) {
              seatArray = [];
              seatData.forEach(function (seats) {
                if (seats.category === seat_providerId_map[m].seatType) {
                  seatArray.push(seats);
                }
              });
              cart_obj.seats = seatArray;
            }
            items_to_cart.push(cart_obj);
          }
        });


        util.log("Items_to_cart is" + JSON.stringify(items_to_cart));
        var blockObject = {
          "items": items_to_cart
        };

        if (Object.keys(deliveryObject).length > 0) {
          blockObject.delivery_details = deliveryObject;
        }
        if (newId) {
          newId = JSON.parse(newId);
          blockObject._id = newId._id;
          blockObject.items = newId.items;
        }
        req.reqdata.supplierStartTime = Date.now();
        util.log("Final request options are " + JSON.stringify(blockObject));
        insiderApi.addToCart(blockObject, function (err, res) {

          req.reqdata.supplierUrl = "insider/holdCall";
          req.reqdata.supplierEndTime = Date.now();

          if (err && (err.status && err.status === HttpStatus.GATEWAY_TIMEOUT)) {
            req.reqdata.status = 0;
            util.log("err response is " + JSON.stringify(err));
            return lcb("Some issue at provider side . Please try again after sometime");
          }
          if (err && (err.status && err.status === HttpStatus.FAILED_DEPENDENCY)) {
            req.reqdata.status = 0;
            util.log("err response is " + JSON.stringify(err));
            return lcb("Provider got timeout , Please try after some time");
          }
          if (err || !res) {
            req.reqdata.status = 0;
            util.log("err response is " + JSON.stringify(err));
            return lcb("Pincode is not valid/serviceable .Please enter other pincode");
          }
          util.log('In addToInsiderCartWithoutParams for insider' + JSON.stringify(res));
          err = '';
          res.items.forEach(function (r) {

            if (r && r.result && r.result.status && r.result.status == 410 && r.result.result == "User has already rsvped") {
              error = false;
            }
            else if (r && r.result && r.result.status && r.result.status != 200) {
              error = true;
              err = r.result.result;
            }
            else if (r && !r.result && ticketPrice != 0) {
              error = true;
              err = "Please update your app for booking this event.";
            }
          });

          if (error) {
            req.reqdata.status = 0;
            util.log('Error adding the selected item at insider cart...Aborting' + err);
            return lcb(err);
          }
          req.reqdata.status = 1;
          req.res_data = { "status": "ok", "price": res.delivery_charges || 0 };
          var sgstDelivery = parseFloat(req.res_data.price * .09 / 1.18).toFixed(4);
          var cgstDelivery = parseFloat(req.res_data.price * .09 / 1.18).toFixed(4);
          req.res_data.sgstDelivery = sgstDelivery;
          req.res_data.cgstDelivery = cgstDelivery;

          newId = res;
          req.res_data.eventsCommission = res.commission_amount.toFixed(2);//setting event commission in metadata for payout
          // create add_on_id and process addon response to save in redis
          addOns.processAddOnResponse(req, res, lcb);
        });
      }


      function redisSave(lcb) {


        util.log("Going to set key" + key);
        newId = JSON.stringify(newId);
        redis.set(key, newId, "EX", 60 * 10, function (err, res) {
          return lcb();

        });
      }
    });

  },
  get2games: function (req, res, next) {
    util.log("middleware: get2games");
    if (Number(req.meta_data.providerId) !== 282)
      return next();


    var seatInfo = req.meta_data.seatInfo;
    var error;
    var token_id;
    var ops = {};
    async.eachSeries(seatInfo, function (seat, callback) {
      if (Number(seat.count) === 0)
        return callback();

      async.series([blockStand], function (err) {
        if (err) {
          util.log('Error while holding ticket');
          return callback(err);
        }
        return callback();
      });

      function blockStand(lcb) {

        ops = {
          "event_id": seat.providerSeatId.split("-")[0],
          "standNo": seat.providerSeatId.split("-")[1],
          "qty": seat.count
        };

        redis.get(seat.providerSeatId + "-" + seat.count, function (err, res) {
          if (!err && res)
            return lcb();
          get2game.blockStand(ops, function (err, res) {
            if (err)
              return lcb(err);
            else if (res.status === "failed")
              return lcb(new Error("Stand block call failed"));
            else {

              token_id = res.token;

              redis.set(seat.providerSeatId + "-" + seat.count, token_id, "EX", 60 * 15, function (err, res) {
                if (!err && res) {
                  util.log("key set successfully");
                  return lcb();
                }
                return lcb(new Error("Unable to set key in redis"));
              });
            }
          });
        });
      }
    }, function (err, res) {
      if (err) {
        error = new Error("Tickets for this category are out of stock! Please try for fewer tickets or some other event.");
        error.status = HttpStatus.PRECONDITION_FAILED;
        error.title = "Tickets for this category are out of stock! Please try for fewer tickets or some other event.";
        return next(error);
      }
      else
        return next();
    });
  },
  validateGSTIN: function (req, res, next) {
    var error;
    var wareHouseDetails={};
    var cart_item = req.cart_item;
    var meta_data = req.meta_data;
    var merchantId = req.meta_data.merchantId;
    var name,alternateName;
    var count = 0;
    util.log("Merchant id is " + merchantId);
    if (mapWarehouse[merchantId]) {
      req.meta_data.wid = mapWarehouse[merchantId];
      req.meta_data.sac = (meta_data.entityType === "events") ? sac_events : sac_parks;
      return next();
    }

    redis.get(merchantId, function (err, res) {
      if (true===false) {

        util.log("Key find successfully " + res);
        var wareHouseDetailsFromRedis=utils.getJson(res);
        req.meta_data.wid = wareHouseDetailsFromRedis.wareHouseId;
        req.meta_data.gstin=wareHouseDetailsFromRedis.gstin;
        req.meta_data.spin=wareHouseDetailsFromRedis.spin;
        req.meta_data.dpin=wareHouseDetailsFromRedis.dpin;
        req.meta_data.sac = (meta_data.entityType === "events") ? sac_events : sac_parks;
        return next();
      }
      ffApi.fetchDataForWareHouse(merchantId, function (err, response) {
        if (err || !response || !response.length) {
          error = new Error("Warehouse not present.Please try again after sometime");
          error.status = HttpStatus.PRECONDITION_FAILED;
          error.title = "Warehouse absent";
          return next(error);
        }
        util.log("response is " + JSON.stringify(response));
        if (meta_data.entityType === "events") {
          response.forEach(function (res) {
            res.warehouse.forEach(function (warehouse) {
              if (res.warehouse.length > 1) {
                error = new Error("Invalid warehouse.Please try again after sometime");
                error.status = HttpStatus.PRECONDITION_FAILED;
                error.title = "Wrong Warehouse created";
                return next(error);
              }
              
              req.meta_data.wid =wareHouseDetails.wareHouseId= warehouse.warehouse_id;

              if(GSTINNotRequiredArr.indexOf(Number(req.meta_data.merchantId)) === -1 && (warehouse.gst===undefined ||warehouse.gst===null || warehouse.gst==='' ||warehouse.gst==='undefined'|| warehouse.gst==='null')){
                error = new Error("GSTIN not present.Please try again after sometime");
                error.status = HttpStatus.PRECONDITION_FAILED;
                error.title = "Warehouse GSTIN not available";
                return next(error);
              }
              req.meta_data.gstin = wareHouseDetails.gstin=warehouse.gst;
              req.meta_data.spin = wareHouseDetails.spin=warehouse.pincode;
              req.meta_data.dpin =wareHouseDetails.dpin= warehouse.pincode;
              req.meta_data.sac = sac_events;
              redis.set(merchantId, JSON.stringify(wareHouseDetails), "EX", 60 * 60 * 24, function (err, res) {
                if (!err && res)
                  util.log("key set successfully");
                return next();
              });
            });
          });
        }
        else {
          name = "a" + meta_data.entityId;
          alternateName = "aa" + meta_data.entityId;
          response.forEach(function (res) {
            res.warehouse.forEach(function (warehouse) {
              var warehouseName = warehouse.name.toLowerCase();
              if (warehouseName === name || warehouseName === alternateName) {
                count++;
                req.meta_data.wid =wareHouseDetails.wareHouseId= warehouse.warehouse_id;
                if(GSTINNotRequiredArr.indexOf(Number(req.meta_data.merchantId)) === -1 && (warehouse.gst===undefined ||warehouse.gst===null || warehouse.gst==='' ||warehouse.gst==='undefined'|| warehouse.gst==='null')){
                  error = new Error("GSTIN not present.Please try again after sometime");
                  error.status = HttpStatus.PRECONDITION_FAILED;
                  error.title = "Warehouse GSTIN not available";
                  return next(error);
                }
                req.meta_data.gstin = wareHouseDetails.gstin=warehouse.gst;
                req.meta_data.spin = wareHouseDetails.spin=warehouse.pincode;
                req.meta_data.dpin =wareHouseDetails.dpin= warehouse.pincode;
              }
            });
          });
          if (count === 0) {
            error = new Error("Warehouse not present.Please try again after sometime");
            error.status = HttpStatus.PRECONDITION_FAILED;
            error.title = "Warehouse absent";
            return next(error);
          }
          if (count > 1) {
            error = new Error("Invalid warehouse.Please try again after sometime");
            error.status = HttpStatus.PRECONDITION_FAILED;
            error.title = "Wrong Warehouse created";
            return next(error);
          }
          req.meta_data.sac = sac_parks;
          redis.set(merchantId, JSON.stringify(wareHouseDetails), "EX", 60 * 60 * 24, function (err, res) {
            if (!err && res)
              util.log("key set successfully");
            return next();
          });
        }

      });
    });
  },
  basePrice: function (req, res, next) {

    var meta_data = req.meta_data;
    var type = meta_data.entityType;
    var seatInfo = req.meta_data.seatInfo;
    var basePrice = 0;
    var price;
    var options = {};
    var update_key;

    async.eachSeries(seatInfo, function (seat, callback) {
      var seatId = seat.seatId;
      options.id = seatId;
      update_key = (meta_data.entityType === "events") ? ("event_prices." + seatId + ".custom_info") : ("park_package_price." + seatId + ".custom_info");
      options = {};
      if (!req.reqdata.overrideDetails[update_key]) {
        update_key = (meta_data.entityType === "events") ? ("event_prices." + seatId + ".price") : ("park_package_price." + seatId + ".ticket_price");
        if (!req.reqdata.overrideDetails[update_key]) {

          var searchKey = (seat.providerSeatId && seat.providerSeatId !== undefined && seat.providerSeatId !== null && seat.providerSeatId != 97700 && Number(offline) !== 1)
                          ? seat.providerSeatId : seat.seatId;
          price = (req.reqdata.price_details[searchKey].custom_info && JSON.parse(req.reqdata.price_details[searchKey].custom_info).basePrice);
          basePrice = parseFloat(basePrice) + (parseFloat(price) * seat.count);
          return callback();
        }
        else {
          basePrice = parseFloat(basePrice) + (parseFloat(req.reqdata.overrideDetails[update_key].value) * seat.count);
          return callback();
        }
      }
      else {
        price = (req.reqdata.overrideDetails[update_key].value && JSON.parse(req.reqdata.overrideDetails[update_key].value).basePrice);
        basePrice = parseFloat(basePrice) + (parseFloat(price) * seat.count);
        return callback();
      }
    }, function (err, res) {
      if (err)
        return next(err);
      req.meta_data.base_price = basePrice;
      return next();
    });
  },

  validateInventory: function (req, res, next) {
    util.log("middleware: validateinventory");
    var meta_data = req.meta_data;
    var seatInfo = meta_data.seatInfo;
    var error;
    eventType = meta_data.entityType;
    provider_id = meta_data.providerId;

    async.eachSeries(seatInfo, checkInventory.bind(checkInventory, req.reqdata.price_details, req.reqdata.overrideDetails), function (err, res) {
      if (err) {

        error = new Error("Sorry !! Only " + Number(db_inventory) + " seats available for " + seatData.seatType + ".Please try again with maximum " + Number(db_inventory) + " seats.");
        error.title = "Sorry !! Only " + Number(db_inventory) + " seats available for " + seatData.seatType + ".Please try again with maximum " + Number(db_inventory) + " seats.";

        if (seatData.packageType) {
          error = new Error("Sorry !! Only " + Number(db_inventory) + " seats available for " + seatData.seatType + " " + seatData.packageType + " Package.Please try again with maximum " + Number(db_inventory) + " seats.");
          error.title = "Sorry !! Only " + Number(db_inventory) + " seats available for " + seatData.seatType + " " + seatData.packageType + " Package.Please try again with maximum " + Number(db_inventory) + " seats.";
        }
        error.status = HttpStatus.PRECONDITION_FAILED;
        return next(error);
      } else
        return next();
    });
  },

  validateParams: function (req, res, next) {
    util.log("middleware: validateparams");
    var cart_item = req.cart_item;
    var config = req.config;
    var meta_data = req.meta_data;
    var options;
    var category = meta_data.category,
      entityName = meta_data.entityName,
      startTime = meta_data.startTime,
      endTime = meta_data.endTime,
      ticketCount = meta_data.ticketCount,
      providerId = meta_data.providerId,
      entityId = meta_data.entityId,
      type = meta_data.entityType;
    var productId = cart_item.product_id;
    var seatInfo = meta_data.seatInfo,
      address = meta_data.address,
      pincode = meta_data.pincode,
      latitude = meta_data.latitude,
      longitude = meta_data.longitude,
      imageUrl = meta_data.imageUrl,
      passenger = meta_data.passenger,
      convFee = meta_data.convFee,
      pgCharges = meta_data.pgCharges || 0,
      totalConvFee = meta_data.totalConvFee,
      totalPgCharges = meta_data.totalPgCharges || 0,
      citySearched = (meta_data.citySearched && meta_data.citySearched.length) ? meta_data.citySearched : "all",
      entityType = meta_data.entityType,
      providerName = meta_data.providerName,
      qty = cart_item.qty || cart_item.quantity;
    var err, err_msg;
    meta_data.seatMap = (meta_data.providerId === 217) ? 1 : 0;
    req.meta_data.ticketCount = req && req.meta_data && req.meta_data.ticketCount ? Number(req.meta_data.ticketCount) : 0;
    req.meta_data.productId = cart_item.product_id;
    meta_data.mPin = meta_data.pincode;
    util.log("Metadata is " + JSON.stringify(meta_data));
    if (!meta_data.category || meta_data.category === undefined || meta_data.category === null) {
      util.log("Populating data for prevalidate request");
      meta_data.category = "Entertainment";
      category = meta_data.category;
    }

    if (!entityName || !entityName.length) {
      err_msg = 'Entity Name is missing';
    } else if (!entityType || !entityType.length) {
      err_msg = 'entityType is missing for entity name : ' + entityName;
    } else if (!category || !category.length) {
      err_msg = 'Category is missing for type :  ' + entityType + ' entity name : ' + entityName;
    } else if (!startTime || !startTime.length) {
      err_msg = 'start time Info is missing for type :  ' + entityType + ' entity name : ' + entityName;
    } else if (!endTime || !endTime.length) {
      err_msg = 'End Time  Info is missing for type :  ' + entityType + ' entity name : ' + entityName;
    } else if (!providerId || isNaN(providerId)) {
      err_msg = 'Provider Id is Missing/Invalid';
    } else if (!ticketCount || isNaN(ticketCount)) {
      err_msg = 'Ticket count is Missing/Invalid';
    } else if (!entityId || isNaN(entityId)) {
      err_msg = 'Entity Id is missing or not a number';
    } else if (!productId || isNaN(productId)) {
      err_msg = 'Product ID is missing/invalid';
    } else if (!address || !address.length) {
      err_msg = ' Address is missing for type :  ' + entityType + ' entity name : ' + entityName;
    } else if (!providerName || !providerName.length) {
      err_msg = 'providerName is missing  for type :  ' + entityType + ' entity name : ' + entityName;
    } else if (!passenger) {
      err_msg = 'Passenger Info is missing';
    } else if (isNaN(convFee)) {
      err_msg = 'convFee is missing or not a number';
    }
    else if (isNaN(totalConvFee)) {
      err_msg = 'totalConvFee is missing or not a number';
    }
    else if (!citySearched || !citySearched.length) {
      err_msg = 'citySearched is missing';
    } else if (!qty || isNaN(qty)) {
      err_msg = 'Quantity is missing or not a number';
    }
    if (err_msg !== undefined) {
      util.log(err_msg);
      err = new Error(err_msg);
      err.status = HttpStatus.PRECONDITION_FAILED;
      err.title = "Invalid parameters for block_ticket call.";
      return next(err);
    }

    if (meta_data.insiderSeats) {

      meta_data.seatMap = 1;
      meta_data.seatInfo.forEach(function (seatData) {
        seatData.seatId = '';
        seatData.matchCount = 0;
      });
      var length, count = 0;
      length = meta_data.insiderSeats.length;
      meta_data.seatInfo.forEach(function (seatData) {
        meta_data.insiderSeats.forEach(function (seats) {
          if (String(seats.category) === String(seatData.seatType)) {
            seatData.matchCount++;
            seatData.seatId = (Number(seatData.matchCount) === Number(seatData.count)) ? (seatData.seatId + seats.name) : (seatData.seatId + seats.name + ",");
          }
        });
      });
    }
    return next();
  },

  validTimeCheck: function (req, res, next) {
    util.log("middleware: validtimecheck");
    var meta_data = req.meta_data;
    var id = meta_data.entityId;
    var type = meta_data.entityType;
    var cut_off;
    var cut_off_time;
    var dTime = [];
    var fTime;
    var curr_date;
    var dateFormat;
    var err, err_msg, flag;
    var startTime = meta_data.startTime;
    var endTime = meta_data.endTime;
    var paytm_id;
    if (new Date(endTime).getTime() < new Date().getTime()) {
      err_msg = 'Booking is closed for today . Try for future dates';
      util.log(err_msg);
      err = new Error(err_msg);
      err.status = HttpStatus.PRECONDITION_FAILED;
      err.title = "Booking is closed for today . Try for future dates";
      return next(err);
    }

    if (type == "events") {
      cut_off = req.reqdata.eventOrpark_details.cut_off;
      flag = req.reqdata.eventOrpark_details.flag;
      paytm_id = req.reqdata.eventOrpark_details.paytm_id;
      var searchKey = 'events.' + req.reqdata.entityId + 'cut_off';
      if (req.reqdata.overrideDetails[searchKey]) {
        cut_off = req.reqdata.overrideDetails[searchKey].value;
      }
      searchKey = 'events.' + req.reqdata.entityId + 'flag';
      if (req.reqdata.overrideDetails[searchKey]) {
        flag = req.reqdata.overrideDetails[searchKey].value;
      }
      if (cut_off === null || flag === 0)
        return next();
      curr_date = moment().format('YYYY-MM-DD');
      dTime = cut_off.split(':');
      dateFormat = utils.format(startTime, 'YYYY-MM-DD');

      if (curr_date === dateFormat) {
        switch (flag) {
          case 1: 
            cut_off_time = moment(new Date(startTime)).subtract(dTime[0], 'h').subtract(dTime[1], 'm').subtract(dTime[2], 's').format('YYYY-MM-DD HH:mm:ss');
            break;
          case 2:
            cut_off_time = moment(new Date(startTime)).add(dTime[0], 'h').add(dTime[1], 'm').add(dTime[2], 's').format('YYYY-MM-DD HH:mm:ss');
            break;
          case 3:
            cut_off_time = moment(new Date(endTime)).subtract(dTime[0], 'h').subtract(dTime[1], 'm').subtract(dTime[2], 's').format('YYYY-MM-DD HH:mm:ss');
            break;
          case 4:
            fTime = dateFormat + " " + cut_off;
            cut_off_time = new Date(fTime);
            break;
        }
      }
      if (new Date().getTime() >= new Date(cut_off_time).getTime()) {
        err_msg = 'Booking is closed for today . Try for future dates';
        util.log(err_msg);
        err = new Error(err_msg);
        err.title = 'Booking is closed for today . Try for future dates';
        err.status = HttpStatus.PRECONDITION_FAILED;
        return next(err);
      }
      return next();
    } else {
      cut_off = req.reqdata.eventOrpark_details.cut_off;
      flag = req.reqdata.eventOrpark_details.flag;
      paytm_id = req.reqdata.eventOrpark_details.paytm_id;
      var searchKey = 'parks.' + req.reqdata.entityId + 'cut_off';
      if (req.reqdata.overrideDetails[searchKey]) {
        cut_off = req.reqdata.overrideDetails[searchKey].value;
      }
      searchKey = 'parks.' + req.reqdata.entityId + 'flag';
      if (req.reqdata.overrideDetails[searchKey]) {
        flag = req.reqdata.overrideDetails[searchKey].value;
      }
      if (cut_off === null || flag === 0)
        return next();
      curr_date = moment().format('YYYY-MM-DD');
      dTime = cut_off.split(':');
      dateFormat = utils.format(startTime, 'YYYY-MM-DD');

      if (curr_date === dateFormat) {
        switch (flag) {
          case 1: 
            cut_off_time = moment(new Date(startTime)).subtract(dTime[0], 'h').subtract(dTime[1], 'm').subtract(dTime[2], 's').format('YYYY-MM-DD HH:mm:ss');
            break;
          case 2:
            cut_off_time = moment(new Date(startTime)).add(dTime[0], 'h').add(dTime[1], 'm').add(dTime[2], 's').format('YYYY-MM-DD HH:mm:ss');
            break;
          case 3:
            cut_off_time = moment(new Date(endTime)).subtract(dTime[0], 'h').subtract(dTime[1], 'm').subtract(dTime[2], 's').format('YYYY-MM-DD HH:mm:ss');
            break;
          case 4:
            fTime = dateFormat + " " + cut_off;
            cut_off_time = new Date(fTime);
            break;
        }
      }
      if (new Date().getTime() >= new Date(cut_off_time).getTime()) {
        err_msg = 'Booking is closed for today . Try for future dates';
        util.log(err_msg);
        err = new Error(err_msg);
        err.title = 'Booking is closed for today . Try for future dates';
        err.status = HttpStatus.PRECONDITION_FAILED;
        return next(err);
      }
      return next();
    }
  },

  validateTime: function (req, res, next) {
    var err, err_msg;
    var meta_data = req.cart_item.meta_data;
    var startTime = meta_data.startTime;
    var endTime = meta_data.endTime;
    var type = req.entityType;
    var providerId = meta_data.providerId;
    var entId = Number(meta_data.entityId);
    var currentDate = utils.format(new Date());

    var params = {
      startTime: meta_data.startTime,
      endTime: meta_data.endTime,
      type: req.entityType,
      providerId: Number(meta_data.providerId),
      entId: Number(meta_data.entityId),
      seatInfo: meta_data.seatInfo,
      overrideArray: req.reqdata.overrideArray
    };
    try {
      prevalidate.checkValidTime(params, function (err) {
        if (err) {
          util.log('[prevalidate.js - validateTime]' + err);
          err.status = HttpStatus.PRECONDITION_FAILED;
          return next(err);
        } else {
          return next();
        }
      });
    } catch (e) {
      if (params.type == 'events' && new Date(params.startTime).getTime() < (new Date(currentDate).getTime() + defalut_cut_off * 60 * 1000)) {
        err_msg = 'startTime is invalid or too soon';
        err = new Error(err_msg);
        return next(err);
      } else {
        return next();
      }
    }
  },

  checkValidTime: function (params, cb) {
    var id = params.entId;
    var type = params.type;
    var options;
    var cut_off;
    var cut_off_time;
    var dTime = [];
    var fTime;
    var curr_date;
    var dateFormat;
    var err, err_msg, flag;
    var startTime = params.startTime;
    var endTime = params.endTime;
    var paytm_id;

    if (new Date(endTime).getTime() < new Date().getTime()) {

      err_msg = 'Booking time Expired';
      util.log(err_msg);
      err = new Error(err_msg);
      err.status = HttpStatus.PRECONDITION_FAILED;
      return cb(err);
    }

    if (type == "events") {
      options = {
        id: id
      };
      eventsApi.select(options, function (error, res) {
        if (error)
          return cb(error);
        else {
          cut_off = res[0].cut_off;
          flag = res[0].flag;
          paytm_id = res[0].paytm_id;
          options =
            {
              paytm_id: paytm_id

            };
          overrideApi.select(options, function (err, data) {
            if (err || !data)
              return cb(err || new Error("Some error occured"));
            data.forEach(function (item) {
              var update_key = item.update_key;
              if (update_key && update_key !== null && update_key !== undefined && update_key.split(".")[2] == "cut_off")
                cut_off = item.value;
              else if (update_key && update_key !== null && update_key !== undefined && update_key.split(".")[2] == "flag")
                flag = item.value;
            });
            if (cut_off === null || flag === 0)
              return cb();
            curr_date = moment().format('YYYY-MM-DD');
            dTime = cut_off.split(':');
            dateFormat = utils.format(startTime, 'YYYY-MM-DD');

            if (curr_date === dateFormat && flag == 1) {
              cut_off_time = moment(new Date(startTime)).subtract(dTime[0], 'h').subtract(dTime[1], 'm').subtract(dTime[2], 's').format('YYYY-MM-DD HH:mm:ss');
              if (new Date().getTime() >= new Date(cut_off_time).getTime()) {
                err_msg = 'Booking time Expired';
                util.log(err_msg);
                err = new Error(err_msg);
                err.status = HttpStatus.PRECONDITION_FAILED;
                return cb(err);
              }
            }
            if (curr_date == dateFormat && flag == 2) {
              cut_off_time = moment(new Date(startTime)).add(dTime[0], 'h').add(dTime[1], 'm').add(dTime[2], 's').format('YYYY-MM-DD HH:mm:ss');
              if (new Date().getTime() >= new Date(cut_off_time).getTime()) {
                err_msg = 'Booking time Expired';
                util.log(err_msg);
                err = new Error(err_msg);
                err.status = HttpStatus.PRECONDITION_FAILED;
                return cb(err);
              }
            }
            if (curr_date == dateFormat && flag == 3) {
              cut_off_time = moment(new Date(endTime)).subtract(dTime[0], 'h').subtract(dTime[1], 'm').subtract(dTime[2], 's').format('YYYY-MM-DD HH:mm:ss');
              if (new Date().getTime() >= new Date(cut_off_time).getTime()) {
                err_msg = 'Booking time Expired';
                util.log(err_msg);
                err = new Error(err_msg);
                err.status = HttpStatus.PRECONDITION_FAILED;
                return cb(err);
              }
            }
            if (curr_date === dateFormat && flag == 4) {
              fTime = dateFormat + " " + cut_off;
              cut_off_time = new Date(fTime).getTime();
              if (new Date().getTime() >= cut_off_time) {
                err_msg = 'Booking time Expired';
                util.log(err_msg);
                err = new Error(err_msg);
                err.status = HttpStatus.PRECONDITION_FAILED;
                return cb(err);
              }
            }
            return cb();
          });
        }
      });
    } else {
      options = {
        id: id
      };
      parksApi.select(options, function (error, res) {
        if (error)
          return cb(error);
        else {
          cut_off = res[0].cut_off;
          flag = res[0].flag;
          paytm_id = res[0].paytm_id;
          options =
            {
              paytm_id: paytm_id

            };
          overrideApi.select(options, function (err, data) {
            if (err || !data)
              return cb(err || new Error("Some error occured"));
            data.forEach(function (item) {
              var update_key = item.update_key;
              if (update_key && update_key !== null && update_key !== undefined && update_key.split(".")[2] == "cut_off")
                cut_off = item.value;
              else if (update_key && update_key !== null && update_key !== undefined && update_key.split(".")[2] == "flag")
                flag = item.value;
            });
            if (cut_off === null || flag === 0)
              return cb();
            curr_date = moment().format('YYYY-MM-DD');
            dTime = cut_off.split(':');
            dateFormat = utils.format(startTime, 'YYYY-MM-DD');

            if (curr_date === dateFormat && flag == 1) {
              cut_off_time = moment(new Date(startTime)).subtract(dTime[0], 'h').subtract(dTime[1], 'm').subtract(dTime[2], 's').format('YYYY-MM-DD HH:mm:ss');
              if (new Date().getTime() >= new Date(cut_off_time).getTime()) {
                err_msg = 'Booking time Expired';
                util.log(err_msg);
                err = new Error(err_msg);
                err.status = HttpStatus.PRECONDITION_FAILED;
                return cb(err);
              }
            }
            if (curr_date == dateFormat && flag == 2) {
              cut_off_time = moment(new Date(startTime)).add(dTime[0], 'h').add(dTime[1], 'm').add(dTime[2], 's').format('YYYY-MM-DD HH:mm:ss');
              if (new Date().getTime() >= new Date(cut_off_time).getTime()) {
                err_msg = 'Booking time Expired';
                util.log(err_msg);
                err = new Error(err_msg);
                err.status = HttpStatus.PRECONDITION_FAILED;
                return cb(err);
              }
            }
            if (curr_date == dateFormat && flag == 3) {
              cut_off_time = moment(new Date(endTime)).subtract(dTime[0], 'h').subtract(dTime[1], 'm').subtract(dTime[2], 's').format('YYYY-MM-DD HH:mm:ss');
              if (new Date().getTime() >= new Date(cut_off_time).getTime()) {
                err_msg = 'Booking time Expired';
                util.log(err_msg);
                err = new Error(err_msg);
                err.status = HttpStatus.PRECONDITION_FAILED;
                return cb(err);
              }
            }
            if (curr_date === dateFormat && flag == 4) {
              fTime = dateFormat + " " + cut_off;
              cut_off_time = new Date(fTime).getTime();
              if (new Date().getTime() >= cut_off_time) {
                err_msg = 'Booking time Expired';
                util.log(err_msg);
                err = new Error(err_msg);
                err.status = HttpStatus.PRECONDITION_FAILED;
                return cb(err);
              }
            }
            return cb();
          });
        }
      });
    }
  },

  validateSeats: function (req, res, next) {
    util.log("middleware: validateSeats");
    var err;
    var meta_data = req.cart_item.meta_data;
    var options = {
      seatInfo: meta_data.seatInfo,
      entityType: req.entityType
    };
    var error;

    var seatInfo = meta_data.seatInfo;

    seatInfo.forEach(function (seat) {
      util.log("seat count is " + seat.count);
      if (Number(seat.count) < 0) {
        error = new Error("Seat Count is negative.Please make valid selection");
        error.status = 412;
        error.tile = "Seat Count is negative.Please make valid selection";
      }
    });

    if (error)
      return next(error);

    next();
  },

  validatePax: function (req, res, next) {
    util.log("middleware: validatepax");
    var err;
    var meta_data = req.cart_item.meta_data;
    if (!meta_data || !meta_data.passenger) {
      util.log("Passenger info is missing");
      err = new Error(" Passenger data is not in proper format. ");
      err.status = HttpStatus.PRECONDITION_FAILED;
      err.title = "Invalid parameters in passenger.";
      return next(err);
    }

    return next();

  },

  getTCS: function(req,res,next) {

    if(DMID.indexOf(Number(req.meta_data.merchantId)) !== -1){
      return next(); //Not sending TCS for these DMIDs
    }
    var ops = {
      config: req.config,
      meta_data: req.meta_data
    };
    var ops = {
      config: req.config,
      meta_data: req.meta_data
    };
    prevalidate.calcPercentageGst(ops,function(err,result){
      if(err){
        util.log("Error in calculating GST percentage");
        return next(err);
      }
      var tcs = {
        "base_price": req.config.price ? Number(req.config.price).toFixed(3) * 1000 : 0, //converting rupee to millirupee
        "igst": result.igst ? result.igst : 0,
        "cgst": result.cgst ? result.cgst : 0,
        "sgst": result.sgst ? result.sgst : 0,
        "cpin": '',
        "spin": req.meta_data.spin || '',
        "dpin": req.meta_data.dpin || '',
        "agstin": req.meta_data.gstin || '',
        "cgstin":'',
        "sac": req.meta_data.sac || '',
        "hsn": '',
      };
      req.meta_data.tcs = tcs;
      return next();
    });
  },

  calcPercentageGst: function calcPercentageGst(ops,cb){
    util.log('Inside calculate gst percentage');
    var perc_cgst = (ops.meta_data.totalCGST && ops.config.price) ? ((Number(ops.meta_data.totalCGST) * 100)/Number(ops.config.price)).toFixed(0) : 0;
    var perc_sgst = (ops.meta_data.totalSGST && ops.config.price) ? ((Number(ops.meta_data.totalSGST) * 100)/Number(ops.config.price)).toFixed(0) : 0;
    var perc_igst = (ops.meta_data.totalIGST && ops.config.price) ? ((Number(ops.meta_data.totalIGST) * 100)/Number(ops.config.price)).toFixed(0) : 0;
    
    var res = {
      cgst : perc_cgst,
      sgst : perc_sgst,
      igst : perc_igst
    };
    cb(null,res);
  },

  respond: function respondfn(req, res, next) {
    req.res_data = req.body;
    next();
  },

  errorNotifyMail: function notificationMail(err, req, res, next) {
    mailNotifier.send(err, req, res, function () {
      if (err) {
        util.log("pre validation failure mail send operation failed");
      }
    });
    next(err);
  },

  fetchData: function (req, res, next) {
    async.series([
      function getProviderDetails(callback) {
        fetchProviderDetails(req.meta_data, function (err, res) {
          if (err)
            return callback(err);
          else {
            req.reqdata.provider_details = res[0];
            offline = req.reqdata.provider_details.offline;
            return callback();
          }
        });
      },
      function getDetails(callback) {
        fetchDetails(req.reqdata.entityType, req.reqdata.entityId, function (err, res) {
          if (err)
            return callback(err);
          else {
            req.reqdata.eventOrpark_details = res;
            return callback();
          }
        });
      },
      function getPriceDetails(callback) {
        fetchPriceDetails(req, function (err, res) {
          if (err) {
            return callback(err);
          } else {
            var priceObject = {};
            for (var i = 0; i < res.length; i++) {
              var key = (res[i].provider_seat_id && res[i].provider_seat_id !== undefined && res[i].provider_seat_id !== null && res[i].provider_seat_id != 97700 && Number(offline) !== 1)
                        ? res[i].provider_seat_id : res[i].id;
              var price;
              price = res[i].price;
              if (String(req.reqdata.entityType) === "events") {
                if (!priceObject[key])
                  priceObject[key] = res[i];
              }
              else {
                req.meta_data.seatInfo.forEach(function (seatData) {
                  if (seatData.providerSeatId && seatData.providerSeatId !== undefined && seatData.providerSeatId !== null && Number(seatData.providerSeatId) != 97700 && Number(offline) !== 1) {
                    if (!priceObject[key] && price === Number(seatData.pricePerSeat) && key === Number(seatData.providerSeatId)) {
                      priceObject[key] = res[i];
                    }
                  }
                  else {
                    if (!priceObject[key] && price === Number(seatData.pricePerSeat) && key === Number(seatData.seatId)) {
                      priceObject[key] = res[i];
                    }
                  }
                });
              }
            }
            util.log("final price object is " + JSON.stringify(priceObject));
            req.reqdata.price_details = priceObject;
            req.reqdata.priceDetailsArray = res;
            return callback();
          }
        })
      },
      function getOverrideDetails(callback) {
        fetchOverrideDetails(req.reqdata.eventOrpark_details.paytm_id, function (err, res) {
          if (err) {
            return callback(err);
          } else {
            var overrideDetails = {};
            req.reqdata.overrideArray = res;
            res.forEach(function (item, index) {
              overrideDetails[item.update_key] = item;
            })
            req.reqdata.overrideDetails = overrideDetails;
            return callback();
          }
        })
      },
    ],
      function (err, result) {
        if (err) {
          return next(err);
        } else {
          next();
        }
      }
    );
  }
};

function fetchDetails(type, eventId, cb) {
  var options = { id: eventId };
  if (String(type) === 'events') {
    eventsApi.select(options, function (err, res) {
      if (err || !res || !res.length)
        return cb(err || new Error("some error occured"));
      else {
        return cb(null, {
          cut_off: res[0].cut_off,
          flag: res[0].flag,
          paytm_id: res[0].paytm_id,
          provider_event_id: res[0].provider_event_id,
          name: res[0].name.replace("/", ""),
          conv_fee: res[0].conv_fee,
          pg_charges: res[0].pg_charges,
          paytm_commission: res[0].paytm_commission,
          id: res[0].id,
          deliveryPrice: res[0].deliveryPrice,
          ticketDelivery: res[0].ticketDelivery,
          courier: res[0].courier
        })
      }
    });
  } else {
    parksApi.select(options, function (err, res) {
      if (err || !res || !res.length)
        return cb(err || new Error("some error occured"));
      else {
        return cb(null, {
          cut_off: res[0].cut_off,
          flag: res[0].flag,
          paytm_id: res[0].paytm_id,
          name: res[0].name.replace("/", ""),
          conv_fee: res[0].conv_fee,
          pg_charges: res[0].pg_charges,
          paytm_commission: res[0].paytm_commission,
          id: res[0].id,
          deliveryPrice: res[0].deliveryPrice,
          ticketDelivery: res[0].ticketDelivery,
          courier: res[0].courier
        })
      }
    })
  }
}

function fetchPriceDetails(req, cb) {
  var options = {};
  req.meta_data.seatInfo.forEach(function (seatData) {
    if (seatData.providerSeatId && seatData.providerSeatId !== undefined && seatData.providerSeatId !== null && seatData.providerSeatId != 97700 && Number(offline) !== 1) {
      options.provider_seat_id ? options.provider_seat_id.push(seatData.providerSeatId) : (options.provider_seat_id = [seatData.providerSeatId]);

    } else {
      options.id ? options.id.push(seatData.seatId) : (options.id = [seatData.seatId]);
    }
    if (Number(offline) !== 1 && String(req.reqdata.entityType) === "events") {
      options.event_id = req.reqdata.entityId;
    }
    if (Number(offline) !== 1 && String(req.reqdata.entityType) === "themeparks") {
      options.park_id = req.reqdata.entityId;
    }

  });
  priceAPI[String(req.reqdata.entityType)].select(options, function (err, res) {
    if (err || !res || !res.length)
      return cb(err || new Error("some error occured"));
    else {
      return cb(null, res);
    }
  });
}

function fetchProviderDetails(meta_data, cb) {
  var provider_ops = {
    id: meta_data.providerId
  };
  entProviders.select(provider_ops, function (err, res) {
    if (err || !res || !res.length)
      return cb(err || new Error("Some error occured"));
    else {
      return cb(null, res);
    }
  });
}

function fetchOverrideDetails(paytmId, cb) {
  var options = {
    paytm_id: paytmId
  };
  overrideApi.select(options, function (err, res) {
    if (err || !res) {
      return cb(err || new Error("Some error occured"));
    } else {
      cb(null, res);
    }
  });
}
function parseConditions(obj) {
  var new_obj = {};
  var parsed_obj;
  try {
    parsed_obj = JSON.parse(obj);
  } catch (err) {
    return {};
  }
  var mins = Number(parsed_obj.cutoff_time.split(' ')[0]);
  var apply_time = parsed_obj.apply.split(' ')[0] == 'before' ? '-' : '+';
  var apply_on = parsed_obj.apply.split(' ')[1];
  new_obj.time = Number(apply_time + mins) * 60 * 1000;
  new_obj.on = apply_on;
  return new_obj;
}
module.exports = prevalidate;


