'use strict';

const domino = require('domino');
const _ = require('underscore');
const MediaSelectors = require('./selectors').MediaSelectors;
const Blacklist = require('./selectors').MediaBlacklist;
const SpokenWikipediaId = require('./selectors').SpokenWikipediaId;

const MATHOID_IMG_CLASS = require('./selectors').MATHOID_IMG_CLASS;
const MIN_IMAGE_SIZE = 48;

/**
 * A MediaWiki media type as represented in Parsoid HTML.
 * @param {!String} resourceSelector the selector for the child element containing the core resource
 * @param {!String} name the image type as referred to internally and in the endpoint response
 */
class MediaType {
    constructor(selector, name) {
        this.selector = selector;
        this.name = name;
    }
}

const Image = new MediaType('img', 'image');
const Video = new MediaType('video', 'video');
// TODO: change to audio only after Parsoid change https://gerrit.wikimedia.org/r/c/mediawiki/services/parsoid/+/449903 is deployed
const Audio = new MediaType('audio, video', 'audio');
// const Audio = new MediaType('video', 'audio');
const Pronunciation = new MediaType(null, Audio.name);
const MathImage = new MediaType(null, Image.name);
const Unknown = new MediaType(null, 'unknown');

function isMathoidImage(elem) {
    return elem.className.includes(MATHOID_IMG_CLASS);
}

function getMediaType(elem) {
    if (elem.getAttribute('typeof')) {
        switch (elem.getAttribute('typeof').slice(0, 8)) {
            case 'mw:Image':
                return Image;
            case 'mw:Video':
                return Video;
            case 'mw:Audio':
                return Audio;
            default:
                return Unknown;
        }
    } else if (elem.getAttribute('rel') === 'mw:MediaLink') {
        return Pronunciation;
    } else if (isMathoidImage(elem)) {
        return MathImage;
    }
}

/**
 * Returns whether the element or an ancestor is part of a blacklisted class
 * @param {!Element} elem an HTML Element
 * @return {!boolean} true if the element or an ancestor is part of a blacklisted class
 */
function isDisallowed(elem) {
    return !!(elem.closest(Blacklist.join()));
}

/**
 * Returns whether the on-page size of an <img> element is small enough to filter from the response
 * @param {!Element} img an <img> element
 */
function isTooSmall(img) {
    const width = img.getAttribute('width');
    const height = img.getAttribute('height');
    return width < MIN_IMAGE_SIZE || height < MIN_IMAGE_SIZE;
}

/**
 * Get file page titles from a NodeList of media elements from Parsoid HTML
 * @param {!string} html raw Parsoid HTML
 * @return {!Array} array containing the information on the media items on the page, in order of
 *          appearance
 */
function getMediaItemInfoFromPage(html) {
    const doc = domino.createDocument(html);
    const elems = doc.querySelectorAll(MediaSelectors.join()).filter((elem) => {
        if (isMathoidImage(elem)) {
            return true;
        }
        const mediaType = getMediaType(elem);
        const resource = mediaType.selector && elem.querySelector(mediaType.selector);
        return (mediaType !== Image || !isTooSmall(resource)) && !isDisallowed(elem);
    });
    const results = [].map.call(elems, (elem) => {
        const mediaType = getMediaType(elem);
        const resource = mediaType.selector && elem.querySelector(mediaType.selector);
        const figCaption = elem.querySelector('figcaption');
        const caption = figCaption && {
            html: figCaption.innerHTML,
            text: figCaption.textContent
        };
        const section = elem.closest('section') || undefined;
        const sectionId = section && parseInt(section.getAttribute('data-mw-section-id'), 10);
        const gallery = elem.closest('.gallery') || undefined;
        const galleryId = gallery && gallery.getAttribute('id');
        // eslint-disable-next-line max-len
        let title = resource && decodeURIComponent(resource.getAttribute('resource').replace(/^.\//, ''));
        let startTime;
        let endTime;
        let thumbTime;
        let audioType;
        let sources;
        let original;
        if (mediaType === Video) {
            const dataMw = JSON.parse(elem.getAttribute('data-mw'));
            if (dataMw) {
                startTime = dataMw.starttime;
                endTime = dataMw.endtime;
                thumbTime = dataMw.thumbtime;
            }
            const sourceElems = elem.getElementsByTagName('source');
            sources = [].map.call(sourceElems, (source) => {
                return {
                    url: source.getAttribute('src'),
                    mime: source.getAttribute('type').split('; ')[0],
                    // eslint-disable-next-line no-useless-escape
                    codecs: source.getAttribute('type').split('; ')[1].split('\"')[1].split(', '),
                    name: source.getAttribute('data-title'),
                    short_name: source.getAttribute('data-shorttitle'),
                    // eslint-disable-next-line max-len
                    width: source.getAttribute('data-file-width') || source.getAttribute('data-width'),
                    // eslint-disable-next-line max-len
                    height: source.getAttribute('data-file-height') || source.getAttribute('data-height')
                };
            });
        } else if (mediaType === Pronunciation) {
            title = decodeURIComponent(`File:${elem.getAttribute('title')}`);
            audioType = 'pronunciation';
        } else if (mediaType === Audio) {
            audioType = elem.closest(SpokenWikipediaId) ? 'spoken' : 'generic';
        } else if (mediaType === MathImage) {
            original = { source: elem.getAttribute('src'), mime: 'image/svg' };
        }
        const result = {
            title,
            section_id: sectionId,
            type: mediaType.name,
            caption,
            start_time: startTime,
            end_time: endTime,
            thumb_time: thumbTime,
            audio_type: audioType,
            gallery_id: galleryId,
            sources,
            showInGallery: mediaType === Image || mediaType === Video
        };
        // Only add 'original' if defined, to avoid otherwise changing the order of properties below
        if (original) {
            result.original = original;
        }
        return result;
    });
    return _.uniq(results, elem => (elem.title || elem.original.source));
}

function combineResponses(apiResponse, pageMediaList) {
    return pageMediaList.map((mediaItem) => {
        if (mediaItem.title) {
            Object.assign(mediaItem, apiResponse[mediaItem.title]);
        }
        delete mediaItem.title;

        // delete 'original' property for videos
        if (mediaItem.sources) {
            delete mediaItem.original;
        }
        return mediaItem;
    });
}

module.exports = {
    getMediaItemInfoFromPage,
    combineResponses,
    isTooSmall,
    isDisallowed,
    testing: {
        imageName: Image.name,
        videoName: Video.name,
        audioName: Audio.name,
    }
};
