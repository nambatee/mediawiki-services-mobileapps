/**
 * MediaWiki API helpers
 */

'use strict';

const BBPromise = require('bluebird');
const sUtil = require('./util');
const api = require('./api-util');
const HTTPError = sUtil.HTTPError;
const Title = require('mediawiki-title').Title;
const Namespace = require('mediawiki-title').Namespace;

const THUMB_URL_PATH_REGEX = /\/thumb\//;
const THUMB_WIDTH_REGEX = /(\d+)px-[^/]+$/;

const mwapi = {};

mwapi.API_QUERY_MAX_TITLES = 50;

mwapi.CARD_THUMB_LIST_ITEM_SIZE = 320;
mwapi.CARD_THUMB_FEATURE_SIZE = 640;

mwapi.LEAD_IMAGE_S = 320;
mwapi.LEAD_IMAGE_M = 640;
mwapi.LEAD_IMAGE_L = 800;
mwapi.LEAD_IMAGE_XL = 1024;

/**
 * Extends an object of keys for an api query with
 * common api parameters.
 * @param {!Object} query
 * @return {!Object}
 */
function apiParams(query) {
    return Object.assign(query, {
        format: 'json',
        formatversion: 2
    });
}

mwapi.checkForMobileviewInResponse = function(logger, response) {
    if (!(response && response.body && response.body.mobileview)) {
        // we did not get our expected mobileview from the MW API, propagate that

        if (response.body.error && response.body.error.code) {
            if (response.body.error.code === 'missingtitle') {
                throw new HTTPError({
                    status: 404,
                    type: 'missingtitle',
                    title: "The page you requested doesn't exist",
                    detail: response.body
                });
            }
            // TODO: add more error conditions here:
        }

        // fall-through to generic error message
        const message = `no mobileview in response: ${JSON.stringify(response.body, null, 2)}`;
        logger.log('warn/mwapi', message);
        throw new HTTPError({
            status: 504,
            type: 'api_error',
            title: 'no mobileview in response',
            detail: response.body
        });
    }
};

mwapi.checkForQueryPagesInResponse = function(req, response) {
    if (!(response && response.body && response.body.query && response.body.query.pages)) {
        // we did not get our expected query.pages from the MW API, propagate that
        req.logger.log('error/mwapi', 'no query.pages in response');
        throw new HTTPError({
            status: 504,
            type: 'api_error',
            title: 'no query.pages in response',
            detail: response.body
        });
    }
};

// copied from restbase/lib/mwUtil.js
mwapi.findSharedRepoDomain = function(siteInfoRes) {
    const sharedRepo = (siteInfoRes.body.query.repos || []).find((repo) => {
        return repo.name === 'shared';
    });
    if (sharedRepo) {
        const domainMatch = /^((:?https?:)?\/\/[^/]+)/.exec(sharedRepo.descBaseUrl);
        if (domainMatch) {
            return domainMatch[0];
        }
    }
};

/**
 * Builds a request for siteinfo data for the MW site for the request domain.
 *
 * @param {!Object} app the application object
 * @param {!Object} req the request object
 * @return {!Promise} a promise resolving as an JSON object containing the response
 */
const siteInfoCache = {};
mwapi.getSiteInfo = function(app, req) {
    const rp = req.params;
    if (!siteInfoCache[rp.domain]) {
        const query = apiParams({
            action: 'query',
            meta: 'siteinfo|allmessages',
            siprop: 'general|languagevariants|namespaces|namespacealiases|specialpagealiases',
            ammessages: 'toc'
        });
        siteInfoCache[rp.domain] = api.mwApiGet(app, req.params.domain, query)
        .then((res) => {
            const general = res.body.query.general;
            const allmessages = res.body.query.allmessages;

            return {
                general: {
                    mainpage: general.mainpage,
                    lang: general.lang,
                    legaltitlechars: general.legaltitlechars,
                    'case': general.case,
                    mobileserver: general.mobileserver,
                    toctitle: allmessages[0].content
                },
                variants: res.body.query.languagevariants
                    && res.body.query.languagevariants[general.lang]
                    && Object.keys(res.body.query.languagevariants[general.lang]),
                namespaces: res.body.query.namespaces,
                namespacealiases: res.body.query.namespacealiases,
                specialpagealiases: res.body.query.specialpagealiases,
                sharedRepoRootURI: mwapi.findSharedRepoDomain(res)
            };
        });
    }
    return siteInfoCache[rp.domain];
};

/**
 * Given protection status for an article simplify it to allow easy reference
 * @param {!Array} mwApiProtectionObj e.g.
 *  [ { type: 'edit', level: 'autoconfirmed', expiry: 'infinity' }
 * @return {!Object} { 'edit': ['autoconfirmed'] },
 */
mwapi.simplifyProtectionObject = function(mwApiProtectionObj) {
    const protection = {};
    mwApiProtectionObj.forEach((entry) => {
        const type = entry.type;
        const level = entry.level;

        if (!protection[type]) {
            protection[type] = [];
        }
        if (protection[type].indexOf(level) === -1) {
            protection[type].push(level);
        }
    });
    return protection;
};

/**
 * Extract primary Earth coordinates, if any, from the API 'coordinates' object
 * @param {!Object} coords the coordinates object from the MW API
 * @return {?Object} the primary Earth coordinates, if any
 */
mwapi.getPrimaryEarthCoordinates = (coords) => {
    if (Array.isArray(coords)) {
        const primary = coords.filter(c => c.globe === 'earth' && c.primary);
        if (primary.length) {
            return {
                latitude: primary[0].lat,
                longitude: primary[0].lon
            };
        }
    }
};

mwapi.queryForMetadata = (app, req, query, responseBuilder) => BBPromise.join(
    mwapi.getSiteInfo(app, req),
    api.mwApiGet(app, req.params.domain, query),
    (siteinfo, metadata) => {
        const body = metadata.body;
        const page = body.query && body.query.pages && body.query.pages[0];
        const normalizedTitle = body.query
            && body.query.normalized && body.query.normalized[0]
            && body.query.normalized[0].to;

        if (!page || page.missing || page.invalid) {
            throw new HTTPError({
                status: 404,
                type: 'missingtitle',
                title: "The page you requested doesn't exist",
                detail: body
            });
        }

        return responseBuilder(page, siteinfo, normalizedTitle);
    });

mwapi.getMetadataForMobileHtml = (app, req) => {
    const query = apiParams({
        action: 'query',
        prop: 'description',
        titles: req.params.title,
    });

    return mwapi.queryForMetadata(app, req, query, (page, siteinfo) => {
        return {
            description: page.description,
            description_source: page.descriptionsource,
            displaytitle: (page.pageprops && page.pageprops.displaytitle) || page.title,
        };
    });
};

mwapi.getMetadataForMetadata = (app, req) => {
    const props = ['pageprops', 'info', 'description', 'langlinks', 'categories'];

    const query = apiParams({
        action: 'query',
        prop: props.join('|'),
        titles: req.params.title,
        lllimit: 'max',
        inprop: 'protection|varianttitles',
        clprop: 'hidden',
        cllimit: 50,
    });

    return mwapi.queryForMetadata(app, req, query, (page, siteinfo) => {
        return {
            title: page.title,
            displaytitle: (page.pageprops && page.pageprops.displaytitle) || page.title,
            coordinates: page.coordinates,
            langlinks: page.langlinks,
            protection: page.protection && mwapi.simplifyProtectionObject(page.protection),
            description_source: page.descriptionsource,
            categories: page.categories,
            variants: siteinfo.variants,
            varianttitles: page.varianttitles,
        };
    });
};

mwapi.getMetadataForSummary = (app, req, thumbSize) => {
    const props = ['coordinates', 'description', 'pageprops', 'pageimages', 'revisions', 'info'];

    const query = apiParams({
        action: 'query',
        prop: props.join('|'),
        titles: req.params.title,
        pilicense: 'any',
        piprop: 'thumbnail|original|name',
        pithumbsize: thumbSize,
        rvprop: 'contentmodel',
        rvslots: 'main',
    });

    return mwapi.queryForMetadata(app, req, query, (page, siteinfo, normalizedTitle) => {
        const revision = page.revisions && page.revisions[0];
        const contentmodel = revision && revision.slots && revision.slots.main
            && revision.slots.main.contentmodel;
        return {
            id: page.pageid,
            title: page.title,
            displaytitle: (page.pageprops && page.pageprops.displaytitle) || page.title,
            pageprops: page.pageprops,
            normalizedtitle: normalizedTitle || page.title,
            ns: page.ns,
            nsText: siteinfo.namespaces[page.ns].name,
            thumbnail: page.thumbnail,
            originalimage: page.original,
            dir: page.pagelanguagedir,
            lang: page.pagelanguagehtmlcode,
            description: page.description,
            geo: page.coordinates && mwapi.getPrimaryEarthCoordinates(page.coordinates),
            mobileHost: siteinfo.general.mobileserver,
            mainpage: siteinfo.general.mainpage === page.title ? true : undefined,
            redirect: page.redirect,
            contentmodel,
            talkNsText: page.ns % 2 === 0 ? siteinfo.namespaces[page.ns + 1]
                && new Namespace(page.ns + 1, siteinfo).getNormalizedText() : undefined
        };
    });
};

/**
 * Builds the request to get page metadata from MW API action=query
 * @param {!Object} app the application object
 * @param {!Object} req the request object
 * @return {!Promise} a promise resolving as an JSON object containing the response
 */
mwapi.getMetadataForMobileSections = (app, req, thumbSize) => {
    const props = ['coordinates', 'description', 'pageprops', 'pageimages', 'revisions',
        'info', 'langlinks'];

    const query = apiParams({
        action: 'query',
        prop: props.join('|'),
        titles: req.params.title,
        pilicense: 'any',
        piprop: 'thumbnail|original|name',
        pithumbsize: thumbSize,
        inprop: 'protection',
        lllimit: 'max',
        rvprop: ['ids', 'timestamp', 'user', 'contentmodel'].join('|'),
        rvslots: 'main',
    });

    return mwapi.queryForMetadata(app, req, query, (page, siteinfo, normalizedTitle) => {
        const revision = page.revisions && page.revisions[0];
        const contentmodel = revision && revision.slots && revision.slots.main
            && revision.slots.main.contentmodel;
        const protection = page.protection && mwapi.simplifyProtectionObject(page.protection);

        return {
            id: page.pageid,
            title: page.title,
            ns: page.ns,
            displaytitle: (page.pageprops && page.pageprops.displaytitle) || page.title,
            normalizedtitle: normalizedTitle || page.title,
            pageprops: page.pageprops,
            lastmodified: revision && revision.timestamp,
            lastmodifier: revision && {
                anon: revision.anon,
                user: revision.user,
                gender: 'unknown' // Always set to unknown until support in API added (T172228)
            },
            image: page.pageimage ? { file: page.pageimage } : undefined,
            languagecount: page.langlinks ? page.langlinks.length : 0,
            thumbnail: page.thumbnail,
            originalimage: page.original,
            protection,
            editable: protection && !protection.edit,
            mainpage: siteinfo.general.mainpage === page.title ? true : undefined,
            revision: revision && revision.revid,
            description: page.description,
            description_source: page.descriptionsource,
            contentmodel,
            redirect: page.redirect, // needed to ensure MCS isn't handling redirects internally
            // primary earth coordinates, if any
            geo: page.coordinates && mwapi.getPrimaryEarthCoordinates(page.coordinates)
        };
    });
};

/**
 * Builds the request to get all sections from MW API action=mobileview.
 * We can avoid using mobileview API when Parsoid returns <section> tags in its
 * response.
 * @param {!Object} app the application object
 * @param {!Object} req the request object
 * @return {!Promise} a promise resolving as an JSON object containing the response
 */
mwapi.getMainPageData = function(app, req) {
    const props = ['text', 'sections', 'languagecount', 'thumb', 'image', 'id', 'revision',
        'description', 'lastmodified', 'normalizedtitle', 'displaytitle', 'protection',
        'editable'];

    const query = apiParams({
        action: 'mobileview',
        page: req.params.title,
        prop: props.join('|'),
        sections: 'all',
        sectionprop: 'toclevel|line|anchor',
        noheadings: true,
        thumbwidth: mwapi.LEAD_IMAGE_XL
    });
    return api.mwApiGet(app, req.params.domain, query)
    .then((response) => {
        mwapi.checkForMobileviewInResponse(req.logger, response);
        return response;
    });
};

mwapi.getRevisionFromExtract = function(extractObj) {
    return extractObj.revisions[0].revid;
};

mwapi.buildTitleResponse = function(pageObj) {
    return { items: [ { title: pageObj.title } ] };
};

mwapi.buildSummaryResponse = function(extractObj, dbtitle) {
    return {
        title: dbtitle,
        normalizedtitle: extractObj.title,
        thumbnail: extractObj.thumbnail,
        description: extractObj.terms && extractObj.terms.description[0],
        extract: extractObj.extract
    };
};

mwapi.getMostReadMetadata = function(app, req, titlesList) {
    const query = apiParams({
        action: 'query',
        meta: 'siteinfo',
        siprop: 'general',
        titles: titlesList
    });
    return api.mwApiGet(app, req.params.domain, query);
};

/**
 * Scales a single image thumbnail URL to another size, if possible.
 * @param {!string} initialUrl an initial thumbnail URL for an image, for example:
 *     https://upload.wikimedia.org/wikipedia/commons/thumb/0/0b/Foo.jpg/640px-Foo.jpg
 * @param {!number} desiredWidth the desired width
 * @param {?number} originalWidth the original width, if known
 * @return {?string} URL updated with the desired size, if available
 */
mwapi.scaledThumbUrl = function(initialUrl, desiredWidth, originalWidth) {
    if (!initialUrl.match(THUMB_URL_PATH_REGEX)) {
        // not a thumb URL
        return;
    }
    const match = THUMB_WIDTH_REGEX.exec(initialUrl);
    if (match) {
        const maxWidth = originalWidth || match[1];
        if (maxWidth > desiredWidth) {
            const newSubstring = match[0].replace(match[1], desiredWidth);
            return initialUrl.replace(THUMB_WIDTH_REGEX, newSubstring);
        }
    }
};

/**
 * Builds a set of URLs for different thumbnail sizes of an image based on the provided array of
 * widths.
 * @param {!string} initialUrl an initial thumbnail URL for an image, for example:
 *     https://upload.wikimedia.org/wikipedia/commons/thumb/0/0b/Foo.jpg/640px-Foo.jpg
 * @param {!number[]} desiredWidths an array of desired widths for which to construct URLs
 * @return {!Object} with widths as keys and the corresponding thumb URLs as values
 */
mwapi.buildImageUrlSet = function(initialUrl, desiredWidths) {
    const result = {};
    desiredWidths.forEach((width) => {
        result[width] = mwapi.scaledThumbUrl(initialUrl, width) || initialUrl;
    });
    return result;
};

/**
 * Builds a set of URLs for lead images with different sizes based on common bucket widths:
 * 320, 640, 800, 1024.
 */
mwapi.buildLeadImageUrls = function(initialUrl) {
    return mwapi.buildImageUrlSet(initialUrl, [ mwapi.LEAD_IMAGE_S, mwapi.LEAD_IMAGE_M,
        mwapi.LEAD_IMAGE_L, mwapi.LEAD_IMAGE_XL ]);
};

/**
 * Get a Title object for a MW title string
 * @param {!string} title a MediaWiki page title string
 * @param {!Object} siteinfo siteinfo from the MW API
 * @return {!Object} a mediawiki-title Title object that can be used to obtain a db-normalized title
 */
mwapi.getTitleObj = function(title, siteinfo) {
    return Title.newFromText(title, siteinfo);
};

mwapi.getDbTitle = function(title, siteinfo) {
    return mwapi.getTitleObj(title, siteinfo).getPrefixedDBKey();
};

module.exports = mwapi;
