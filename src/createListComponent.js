// @flow

import memoizeOne from 'memoize-one';
import { createElement, PureComponent } from 'react';
import { cancelTimeout, requestTimeout } from './timer';

import type { TimeoutID } from './timer';
import { normalizeScrollLeft } from './domHelpers';

export type ScrollToAlign = 'auto' | 'smart' | 'center' | 'start' | 'end';

type itemSize = number | ((index: number) => number);
// TODO Deprecate directions "horizontal" and "vertical"
type Direction = 'ltr' | 'rtl' | 'horizontal' | 'vertical';
type Layout = 'horizontal' | 'vertical';

type RenderComponentProps<T> = {|
  data: T,
  index: number,
  isScrolling?: boolean,
  style: Object,
|};
type RenderComponent<T> = React$ComponentType<$Shape<RenderComponentProps<T>>>;

type ScrollDirection = 'forward' | 'backward';

type onItemsRenderedCallback = ({
  overscanStartIndex: number,
  overscanStopIndex: number,
  visibleStartIndex: number,
  visibleStopIndex: number,
}) => void;
type onScrollCallback = ({
  scrollDirection: ScrollDirection,
  scrollOffset: number,
  scrollUpdateWasRequested: boolean,
}) => void;

type ScrollEvent = SyntheticEvent<HTMLDivElement>;
type ItemStyleCache = { [index: number]: Object };

export type Props<T> = {|
  children: RenderComponent<T>,
  className?: string,
  direction: Direction,
  height: number | string,
  initialScrollOffset?: number,
  innerRef?: any,
  innerElementType?: React$ElementType,
  innerTagName?: string, // deprecated
  itemCount: number,
  itemData: T,
  itemKey?: (index: number, data: T) => any,
  itemSize: itemSize,
  layout: Layout,
  onItemsRendered?: onItemsRenderedCallback,
  onScroll?: onScrollCallback,
  outerRef?: any,
  outerElementType?: React$ElementType,
  outerTagName?: string, // deprecated
  overscanCount: number,
  style?: Object,
  useIsScrolling: boolean,
  width: number | string,
|};

type State = {|
  instance: any,
  isScrolling: boolean,
  scrollDirection: ScrollDirection,
  scrollOffset: number,
  normalizedScrollLeft: number,
  scrollUpdateWasRequested: boolean,
|};

type GetItemOffset = (
  props: Props<any>,
  index: number,
  instanceProps: any
) => number;
type GetItemSize = (
  props: Props<any>,
  index: number,
  instanceProps: any
) => number;
type GetEstimatedTotalSize = (props: Props<any>, instanceProps: any) => number;
type GetOffsetForIndexAndAlignment = (
  props: Props<any>,
  index: number,
  align: ScrollToAlign,
  scrollOffset: number,
  instanceProps: any
) => number;
type GetStartIndexForOffset = (
  props: Props<any>,
  offset: number,
  instanceProps: any
) => number;
type GetStopIndexForStartIndex = (
  props: Props<any>,
  startIndex: number,
  scrollOffset: number,
  instanceProps: any
) => number;
type InitInstanceProps = (props: Props<any>, instance: any) => any;
type ValidateProps = (props: Props<any>) => void;

const IS_SCROLLING_DEBOUNCE_INTERVAL = 150;

const defaultItemKey = (index: number, data: any) => index;

// In DEV mode, this Set helps us only log a warning once per component instance.
// This avoids spamming the console every time a render happens.
let devWarningsDirection = null;
let devWarningsTagName = null;
if (process.env.NODE_ENV !== 'production') {
  if (typeof window !== 'undefined' && typeof window.WeakSet !== 'undefined') {
    devWarningsDirection = new WeakSet();
    devWarningsTagName = new WeakSet();
  }
}

export default function createListComponent({
  getItemOffset,
  getEstimatedTotalSize,
  getItemSize,
  getOffsetForIndexAndAlignment,
  getStartIndexForOffset,
  getStopIndexForStartIndex,
  initInstanceProps,
  shouldResetStyleCacheOnItemSizeChange,
  validateProps,
}: {|
  getItemOffset: GetItemOffset,
  getEstimatedTotalSize: GetEstimatedTotalSize,
  getItemSize: GetItemSize,
  getOffsetForIndexAndAlignment: GetOffsetForIndexAndAlignment,
  getStartIndexForOffset: GetStartIndexForOffset,
  getStopIndexForStartIndex: GetStopIndexForStartIndex,
  initInstanceProps: InitInstanceProps,
  shouldResetStyleCacheOnItemSizeChange: boolean,
  validateProps: ValidateProps,
|}) {
  return class List<T> extends PureComponent<Props<T>, State> {
    _instanceProps: any = initInstanceProps(this.props, this);
    _outerRef: ?HTMLDivElement;
    _resetIsScrollingTimeoutId: TimeoutID | null = null;

    static defaultProps = {
      direction: 'ltr',
      itemData: undefined,
      layout: 'vertical',
      overscanCount: 2,
      useIsScrolling: false,
    };

    // Always use explicit constructor for React components.
    // It produces less code after transpilation. (#26)
    // eslint-disable-next-line no-useless-constructor
    constructor(props: Props<T>) {
      super(props);

      const { direction, layout, initialScrollOffset } = this.props;

      let scrollOffset;
      let initialNormalizedScrollLeft = 0;
      if (layout === 'horizontal' || direction === 'horizontal') {
        const mappedDirection = this._mappedDirectionForNormalization();
        const width = this._widthPropAsNumber();
        const estimatedWidth = getEstimatedTotalSize(
          this.props,
          this._instanceProps
        );
        scrollOffset =
          typeof initialScrollOffset === 'number'
            ? initialScrollOffset
            : normalizeScrollLeft({
                direction: mappedDirection,
                scrollLeft: 0,
                clientWidth: Math.min(((width: any): number), estimatedWidth),
                scrollWidth: estimatedWidth,
              });

        initialNormalizedScrollLeft = normalizeScrollLeft({
          direction: mappedDirection,
          scrollLeft: scrollOffset,
          clientWidth: width,
          scrollWidth: estimatedWidth,
        });
      } else {
        scrollOffset =
          typeof initialScrollOffset === 'number' ? initialScrollOffset : 0;
      }

      this.state = {
        instance: this,
        isScrolling: false,
        scrollDirection: 'forward',
        scrollOffset,
        normalizedScrollLeft: initialNormalizedScrollLeft,
        scrollUpdateWasRequested: false,
      };
    }

    static getDerivedStateFromProps(
      nextProps: Props<T>,
      prevState: State
    ): $Shape<State> | null {
      validateSharedProps(nextProps, prevState);
      validateProps(nextProps);
      return null;
    }

    scrollTo(scrollOffset: number): void {
      let normalizedScrollLeft;

      const { layout, direction } = this.props;
      if (layout === 'horizontal' || direction === 'horizontal') {
        const scrollWidth = getEstimatedTotalSize(
          this.props,
          this._instanceProps
        );
        const mappedDirection = this._mappedDirectionForNormalization();
        const width = this._widthPropAsNumber();
        normalizedScrollLeft = normalizeScrollLeft({
          direction: mappedDirection,
          scrollLeft: scrollOffset,
          scrollWidth,
          clientWidth: width,
        });

        if (normalizedScrollLeft < 0) {
          normalizedScrollLeft = 0;

          scrollOffset = normalizeScrollLeft({
            direction: mappedDirection,
            scrollLeft: normalizedScrollLeft,
            scrollWidth,
            clientWidth: width,
          });
        }
      } else {
        scrollOffset = Math.max(0, scrollOffset);
      }

      this.setState(prevState => {
        if (prevState.scrollOffset === scrollOffset) {
          return null;
        }

        const directionCalculation =
          layout === 'horizontal' || direction === 'horizontal'
            ? prevState.normalizedScrollLeft < normalizedScrollLeft
            : prevState.scrollOffset < scrollOffset;

        return {
          scrollDirection: directionCalculation ? 'forward' : 'backward',
          scrollOffset: scrollOffset,
          normalizedScrollLeft: normalizedScrollLeft,
          scrollUpdateWasRequested: true,
        };
      }, this._resetIsScrollingDebounced);
    }

    scrollToItem(index: number, align: ScrollToAlign = 'auto'): void {
      const { itemCount, layout, direction } = this.props;
      const { scrollOffset, normalizedScrollLeft } = this.state;

      index = Math.max(0, Math.min(index, itemCount - 1));

      let newNormalizedScrollOffset = undefined;
      let browserOffset = scrollOffset;
      let scrollDirection = 'backward';
      if (layout === 'horizontal' || direction === 'horizontal') {
        newNormalizedScrollOffset = getOffsetForIndexAndAlignment(
          this.props,
          index,
          align,
          normalizedScrollLeft,
          this._instanceProps
        );

        const startIndex = getStartIndexForOffset(
          this.props,
          newNormalizedScrollOffset,
          this._instanceProps
        );
        const stopIndex = getStopIndexForStartIndex(
          this.props,
          startIndex,
          newNormalizedScrollOffset,
          this._instanceProps
        );

        if (normalizedScrollLeft < newNormalizedScrollOffset) {
          scrollDirection = 'forward';
        }

        const overscanForward =
          scrollDirection === 'forward'
            ? Math.max(1, this.props.overscanCount || 1)
            : 1;

        // This will update the index that we've measured up to matching that to what we'd measure once rendered
        getItemOffset(
          this.props,
          Math.max(0, Math.min(itemCount - 1, stopIndex + overscanForward)),
          this._instanceProps
        );

        // Re-calculate the estimated width now that we've measured more
        // columns in getOffsetForIndexAndAlignment above so that we can convert
        // back from a normalized scrollLeft to one the browser understands.
        // This is important as we'll change the width to this new value when
        // rendered. If we use the existing width to calculate where we want the
        // browser to scroll to that value will be incorrect by the time it's happened.
        const newEstimatedTotalWidth = getEstimatedTotalSize(
          this.props,
          this._instanceProps
        );

        browserOffset = normalizeScrollLeft({
          direction: this._mappedDirectionForNormalization(),
          scrollLeft: newNormalizedScrollOffset,
          scrollWidth: newEstimatedTotalWidth,
          clientWidth: Math.min(
            this._widthPropAsNumber(),
            newEstimatedTotalWidth
          ),
        });
      } else {
        browserOffset = getOffsetForIndexAndAlignment(
          this.props,
          index,
          align,
          scrollOffset,
          this._instanceProps
        );

        if (scrollOffset < browserOffset) {
          scrollDirection = 'forward';
        }
      }

      this.setState(prevState => {
        if (prevState.scrollOffset === browserOffset) {
          return null;
        }

        return {
          scrollDirection: scrollDirection,
          scrollOffset: browserOffset,
          normalizedScrollLeft: newNormalizedScrollOffset,
          scrollUpdateWasRequested: true,
        };
      }, this._resetIsScrollingDebounced);
    }

    componentDidMount() {
      const { direction, initialScrollOffset, layout } = this.props;

      if (typeof initialScrollOffset === 'number' && this._outerRef !== null) {
        // TODO Deprecate direction "horizontal"
        if (direction === 'horizontal' || layout === 'horizontal') {
          ((this
            ._outerRef: any): HTMLDivElement).scrollLeft = initialScrollOffset;
        } else {
          ((this
            ._outerRef: any): HTMLDivElement).scrollTop = initialScrollOffset;
        }
      }

      this._callPropsCallbacks();
    }

    componentDidUpdate() {
      const { direction, layout } = this.props;
      const { scrollOffset, scrollUpdateWasRequested } = this.state;

      if (scrollUpdateWasRequested && this._outerRef !== null) {
        // TODO Deprecate direction "horizontal"
        if (direction === 'horizontal' || layout === 'horizontal') {
          ((this._outerRef: any): HTMLDivElement).scrollLeft = scrollOffset;
          // Now that scrollLeft has changed programmatically we need to update the normalized version of this
          // We can't calculate it before now because we may have changed the scrollWidth of the component as
          // a result of measuring more elements and we need that to calculate a normalized version.
          const normalizedScrollLeft = normalizeScrollLeft({
            direction: this._mappedDirectionForNormalization(),
            scrollLeft: scrollOffset,
            scrollWidth: ((this._outerRef: any): HTMLDivElement).scrollWidth,
            clientWidth: this._widthPropAsNumber(),
          });

          this.setState({
            normalizedScrollLeft,
          });
        } else {
          ((this._outerRef: any): HTMLDivElement).scrollTop = scrollOffset;
        }
      }

      this._callPropsCallbacks();
    }

    componentWillUnmount() {
      if (this._resetIsScrollingTimeoutId !== null) {
        cancelTimeout(this._resetIsScrollingTimeoutId);
      }
    }

    render() {
      const {
        children,
        className,
        direction,
        height,
        innerRef,
        innerElementType,
        innerTagName,
        itemCount,
        itemData,
        itemKey = defaultItemKey,
        layout,
        outerElementType,
        outerTagName,
        style,
        useIsScrolling,
        width,
      } = this.props;
      const { isScrolling } = this.state;

      // TODO Deprecate direction "horizontal"
      const isHorizontal =
        direction === 'horizontal' || layout === 'horizontal';

      const onScroll = isHorizontal
        ? this._onScrollHorizontal
        : this._onScrollVertical;

      const [startIndex, stopIndex] = this._getRangeToRender();

      const items = [];
      if (itemCount > 0) {
        for (let index = startIndex; index <= stopIndex; index++) {
          items.push(
            createElement(children, {
              data: itemData,
              key: itemKey(index, itemData),
              index,
              isScrolling: useIsScrolling ? isScrolling : undefined,
              style: this._getItemStyle(index),
            })
          );
        }
      }

      // Read this value AFTER items have been created,
      // So their actual sizes (if variable) are taken into consideration.
      const estimatedTotalSize = getEstimatedTotalSize(
        this.props,
        this._instanceProps
      );

      return createElement(
        outerElementType || outerTagName || 'div',
        {
          className,
          onScroll,
          ref: this._outerRefSetter,
          style: {
            position: 'relative',
            height,
            width,
            overflow: 'auto',
            WebkitOverflowScrolling: 'touch',
            willChange: 'transform',
            direction,
            ...style,
          },
        },
        createElement(innerElementType || innerTagName || 'div', {
          children: items,
          ref: innerRef,
          style: {
            height: isHorizontal ? '100%' : estimatedTotalSize,
            pointerEvents: isScrolling ? 'none' : undefined,
            width: isHorizontal ? estimatedTotalSize : '100%',
          },
        })
      );
    }

    _callOnItemsRendered: (
      overscanStartIndex: number,
      overscanStopIndex: number,
      visibleStartIndex: number,
      visibleStopIndex: number
    ) => void;
    _callOnItemsRendered = memoizeOne(
      (
        overscanStartIndex: number,
        overscanStopIndex: number,
        visibleStartIndex: number,
        visibleStopIndex: number
      ) =>
        ((this.props.onItemsRendered: any): onItemsRenderedCallback)({
          overscanStartIndex,
          overscanStopIndex,
          visibleStartIndex,
          visibleStopIndex,
        })
    );

    _callOnScroll: (
      scrollDirection: ScrollDirection,
      scrollOffset: number,
      scrollUpdateWasRequested: boolean
    ) => void;
    _callOnScroll = memoizeOne(
      (
        scrollDirection: ScrollDirection,
        scrollOffset: number,
        scrollUpdateWasRequested: boolean
      ) =>
        ((this.props.onScroll: any): onScrollCallback)({
          scrollDirection,
          scrollOffset,
          scrollUpdateWasRequested,
        })
    );

    _callPropsCallbacks() {
      if (typeof this.props.onItemsRendered === 'function') {
        const { itemCount } = this.props;
        if (itemCount > 0) {
          const [
            overscanStartIndex,
            overscanStopIndex,
            visibleStartIndex,
            visibleStopIndex,
          ] = this._getRangeToRender();
          this._callOnItemsRendered(
            overscanStartIndex,
            overscanStopIndex,
            visibleStartIndex,
            visibleStopIndex
          );
        }
      }

      if (typeof this.props.onScroll === 'function') {
        const {
          scrollDirection,
          scrollOffset,
          scrollUpdateWasRequested,
        } = this.state;
        this._callOnScroll(
          scrollDirection,
          scrollOffset,
          scrollUpdateWasRequested
        );
      }
    }

    // Lazily create and cache item styles while scrolling,
    // So that pure component sCU will prevent re-renders.
    // We maintain this cache, and pass a style prop rather than index,
    // So that List can clear cached styles and force item re-render if necessary.
    _getItemStyle: (index: number) => Object;
    _getItemStyle = (index: number): Object => {
      const { direction, itemSize, layout } = this.props;

      const itemStyleCache = this._getItemStyleCache(
        shouldResetStyleCacheOnItemSizeChange && itemSize,
        shouldResetStyleCacheOnItemSizeChange && layout,
        shouldResetStyleCacheOnItemSizeChange && direction
      );

      let style;
      if (itemStyleCache.hasOwnProperty(index)) {
        style = itemStyleCache[index];
      } else {
        const offset = getItemOffset(this.props, index, this._instanceProps);
        const size = getItemSize(this.props, index, this._instanceProps);

        // TODO Deprecate direction "horizontal"
        const isHorizontal =
          direction === 'horizontal' || layout === 'horizontal';

        itemStyleCache[index] = style = {
          position: 'absolute',
          [direction === 'rtl' ? 'right' : 'left']: isHorizontal ? offset : 0,
          top: !isHorizontal ? offset : 0,
          height: !isHorizontal ? size : '100%',
          width: isHorizontal ? size : '100%',
        };
      }

      return style;
    };

    _getItemStyleCache: (_: any, __: any, ___: any) => ItemStyleCache;
    _getItemStyleCache = memoizeOne((_: any, __: any, ___: any) => ({}));

    _getRangeToRender(): [number, number, number, number] {
      const { itemCount, overscanCount, direction, layout } = this.props;
      const {
        isScrolling,
        scrollDirection,
        scrollOffset,
        normalizedScrollLeft,
      } = this.state;

      if (itemCount === 0) {
        return [0, 0, 0, 0];
      }

      const offsetToUse =
        layout === 'vertical' || direction === 'vertical'
          ? scrollOffset
          : normalizedScrollLeft;

      const startIndex = getStartIndexForOffset(
        this.props,
        offsetToUse,
        this._instanceProps
      );
      const stopIndex = getStopIndexForStartIndex(
        this.props,
        startIndex,
        offsetToUse,
        this._instanceProps
      );

      // Overscan by one item in each direction so that tab/focus works.
      // If there isn't at least one extra item, tab loops back around.
      const overscanBackward =
        !isScrolling || scrollDirection === 'backward'
          ? Math.max(1, overscanCount)
          : 1;
      const overscanForward =
        !isScrolling || scrollDirection === 'forward'
          ? Math.max(1, overscanCount)
          : 1;

      return [
        Math.max(0, startIndex - overscanBackward),
        Math.max(0, Math.min(itemCount - 1, stopIndex + overscanForward)),
        startIndex,
        stopIndex,
      ];
    }

    _onScrollHorizontal = (event: ScrollEvent): void => {
      const { clientWidth, scrollLeft, scrollWidth } = event.currentTarget;
      this.setState(prevState => {
        if (prevState.scrollOffset === scrollLeft) {
          // Scroll position may have been updated by cDM/cDU,
          // In which case we don't need to trigger another render,
          // And we don't want to update state.isScrolling.
          return null;
        }

        const normalizedScrollLeft = normalizeScrollLeft({
          direction: this._mappedDirectionForNormalization(),
          scrollLeft,
          clientWidth,
          scrollWidth,
        });

        return {
          isScrolling: true,
          scrollDirection:
            prevState.normalizedScrollLeft < normalizedScrollLeft
              ? 'forward'
              : 'backward',
          scrollOffset: scrollLeft,
          normalizedScrollLeft,
          scrollUpdateWasRequested: false,
        };
      }, this._resetIsScrollingDebounced);
    };

    _onScrollVertical = (event: ScrollEvent): void => {
      const { scrollTop } = event.currentTarget;
      this.setState(prevState => {
        if (prevState.scrollOffset === scrollTop) {
          // Scroll position may have been updated by cDM/cDU,
          // In which case we don't need to trigger another render,
          // And we don't want to update state.isScrolling.
          return null;
        }

        return {
          isScrolling: true,
          scrollDirection:
            prevState.scrollOffset < scrollTop ? 'forward' : 'backward',
          scrollOffset: scrollTop,
          scrollUpdateWasRequested: false,
        };
      }, this._resetIsScrollingDebounced);
    };

    _outerRefSetter = (ref: any): void => {
      const { outerRef } = this.props;

      this._outerRef = ((ref: any): HTMLDivElement);

      if (typeof outerRef === 'function') {
        outerRef(ref);
      } else if (
        outerRef != null &&
        typeof outerRef === 'object' &&
        outerRef.hasOwnProperty('current')
      ) {
        outerRef.current = ref;
      }
    };

    _resetIsScrollingDebounced = () => {
      if (this._resetIsScrollingTimeoutId !== null) {
        cancelTimeout(this._resetIsScrollingTimeoutId);
      }

      this._resetIsScrollingTimeoutId = requestTimeout(
        this._resetIsScrolling,
        IS_SCROLLING_DEBOUNCE_INTERVAL
      );
    };

    _resetIsScrolling = () => {
      this._resetIsScrollingTimeoutId = null;

      this.setState({ isScrolling: false }, () => {
        // Clear style cache after state update has been committed.
        // This way we don't break pure sCU for items that don't use isScrolling param.
        this._getItemStyleCache(-1, null);
      });
    };

    // We've got to decide on a direction of ltr/rtl to determine a
    // normalized scrollLeft in the case of 'horizontal' so pick ltr.
    _mappedDirectionForNormalization(): 'ltr' | 'rtl' {
      const direction = this.props.direction;
      return direction === 'horizontal' || direction === 'vertical'
        ? 'ltr'
        : direction;
    }

    _widthPropAsNumber(): number {
      return ((this.props.width: any): number);
    }
  };
}

// NOTE: I considered further wrapping individual items with a pure ListItem component.
// This would avoid ever calling the render function for the same index more than once,
// But it would also add the overhead of a lot of components/fibers.
// I assume people already do this (render function returning a class component),
// So my doing it would just unnecessarily double the wrappers.

const validateSharedProps = (
  {
    children,
    direction,
    height,
    layout,
    innerTagName,
    outerTagName,
    width,
  }: Props<any>,
  { instance }: State
): void => {
  if (process.env.NODE_ENV !== 'production') {
    if (innerTagName != null || outerTagName != null) {
      if (devWarningsTagName && !devWarningsTagName.has(instance)) {
        devWarningsTagName.add(instance);
        console.warn(
          'The innerTagName and outerTagName props have been deprecated. ' +
            'Please use the innerElementType and outerElementType props instead.'
        );
      }
    }

    // TODO Deprecate direction "horizontal"
    const isHorizontal = direction === 'horizontal' || layout === 'horizontal';

    switch (direction) {
      case 'horizontal':
      case 'vertical':
        if (devWarningsDirection && !devWarningsDirection.has(instance)) {
          devWarningsDirection.add(instance);
          console.warn(
            'The direction prop should be either "ltr" (default) or "rtl". ' +
              'Please use the layout prop to specify "vertical" (default) or "horizontal" orientation.'
          );
        }
        break;
      case 'ltr':
      case 'rtl':
        // Valid values
        break;
      default:
        throw Error(
          'An invalid "direction" prop has been specified. ' +
            'Value should be either "ltr" or "rtl". ' +
            `"${direction}" was specified.`
        );
    }

    switch (layout) {
      case 'horizontal':
      case 'vertical':
        // Valid values
        break;
      default:
        throw Error(
          'An invalid "layout" prop has been specified. ' +
            'Value should be either "horizontal" or "vertical". ' +
            `"${layout}" was specified.`
        );
    }

    if (children == null) {
      throw Error(
        'An invalid "children" prop has been specified. ' +
          'Value should be a React component. ' +
          `"${children === null ? 'null' : typeof children}" was specified.`
      );
    }

    if (isHorizontal && typeof width !== 'number') {
      throw Error(
        'An invalid "width" prop has been specified. ' +
          'Horizontal lists must specify a number for width. ' +
          `"${width === null ? 'null' : typeof width}" was specified.`
      );
    } else if (!isHorizontal && typeof height !== 'number') {
      throw Error(
        'An invalid "height" prop has been specified. ' +
          'Vertical lists must specify a number for height. ' +
          `"${height === null ? 'null' : typeof height}" was specified.`
      );
    }
  }
};
